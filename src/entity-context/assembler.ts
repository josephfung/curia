// src/entity-context/assembler.ts
//
// EntityContextAssembler: the core assembly pipeline for entity context payloads.
//
// For each entity ID, assembles:
//   1. KG node lookup (type, label, properties)
//   2. Facts — KG nodes of type 'fact' linked via 'relates_to' edges
//   3. Contact record lookup (contacts table, by kg_node_id)
//   4. Connected accounts (contact_calendars today; email/integrations in future)
//   5. First-degree relationships (kg_edges where one side is the entity, depth=1)
//
// All of the above is a database read path — no LLM involvement, no external API
// calls. Should complete in single-digit milliseconds for typical entities.
//
// A simple TTL cache (5-minute default) avoids redundant DB queries when multiple
// skills operate on the same entity in a single conversation. Cache keys are
// entity/contact IDs; invalidation is handled by clearCacheForEntity() which
// callers (ContactService, EntityMemory) call after mutations.
//
// assembleMany() wraps each per-ID call in its own try/catch so that a DB error
// on one entity doesn't abort the entire batch — errored IDs are logged and placed
// in the `failed` array rather than propagating.
//
// Misses are reported in three separate buckets, because they mean different things
// (#1694 / ADR-040, #1702, #1707):
//   unresolved — the ID matched no contact and no live KG node.
//   nodeless   — the ID matched a real contact that cannot carry context. Either it
//                never had a KG node (`cause: 'missing'`), or its node was archived
//                (`cause: 'archived'`) — decay retirement, or contact deletion under
//                ADR-040. Both are structurally unable to carry facts, relationships,
//                or context. Collapsing either into `unresolved` made an agent read
//                "cannot hold knowledge" as "we know nothing about them".
//   failed     — assembly threw. Classified as retryable or not; never evidence the
//                contact is unknown (#1702).

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { EntityContext, EntityFact, ConnectedAccount, EntityRelationship } from './types.js';
import { CANONICAL_ATTRIBUTE_MAP } from '../contacts/canonical-attribute-guard.js';
import type { ContactCanonicalFields } from '../contacts/types.js';

// TTL for cached entity context payloads (5 minutes per spec).
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  context: EntityContext;
  expiresAt: number;
}

/** Why a real contact cannot carry context. */
export type NodelessCause = 'missing' | 'archived';

/** A contact that exists but cannot carry context. */
export interface NodelessContact {
  /** The string the caller passed in (contact UUID or email), so it can correlate results. */
  inputId: string;
  contactId: string;
  displayName: string;
  /**
   * `missing` — `kg_node_id` is NULL; the contact never had a stored profile.
   * `archived` — `kg_node_id` points at a node with `archived_at` set; the profile
   * was retired (dream-engine decay, or contact deletion under ADR-040).
   */
  cause: NodelessCause;
}

/** An ID whose assembly threw — classified for retry, not a miss. */
export interface AssembleManyFailedEntry {
  /** The string the caller passed in (contact UUID, KG node ID, or email). */
  inputId: string;
  /** True when the error is likely transient (timeout, connection limit, reset). */
  retryable: boolean;
}

export interface AssembleManyResult {
  entities: EntityContext[];
  /** IDs that matched no contact and no KG node. */
  unresolved: string[];
  /** Contacts that exist but cannot hold knowledge (no node, or archived node). Disjoint from `unresolved`. */
  nodeless: NodelessContact[];
  /** IDs whose assembly errored. Disjoint from `unresolved` and `nodeless`. */
  failed: AssembleManyFailedEntry[];
}

/** Outcome of resolving a caller-supplied ID to something assemblable. */
type ResolvedInput =
  | { kind: 'node'; kgNodeId: string }
  | { kind: 'nodeless'; contactId: string; displayName: string; cause: NodelessCause }
  | { kind: 'unknown' };

/** Outcome of a single assembly attempt, with the reason for a miss preserved. */
type AssembleOutcome =
  | { kind: 'assembled'; context: EntityContext }
  | { kind: 'nodeless'; entry: NodelessContact }
  | { kind: 'unknown' };

/**
 * Assembles EntityContext payloads from the database.
 * Holds a simple TTL cache to avoid redundant queries within a conversation.
 */
export class EntityContextAssembler {
  private cache = new Map<string, CacheEntry>();

  // Reverse mapping: entityId -> Set of all cache keys that hold it.
  // Used by clearCacheForEntity() to ensure stale entries can't be reached
  // by either the original input ID or the resolved entity ID.
  private entityToCacheKeys = new Map<string, Set<string>>();

  constructor(private pool: DbPool, private logger: Logger) {}

  /**
   * Resolve one or more IDs to EntityContext payloads.
   *
   * Resolution priority for each ID:
   *   1. Matches a contacts.id with a live kg_node_id → assemble from that KG node
   *   2. Matches a contacts.id with no node, or whose node is archived → `nodeless`
   *   3. Matches a live kg_nodes.id directly → assemble from that KG node
   *   4. Matches an archived kg_nodes.id owned by a contact → `nodeless` (cause archived)
   *   5. No match → included in `unresolved` (not a hard error)
   *
   * Each ID is assembled independently; a DB error on one ID logs at error and
   * adds the ID to `failed` without aborting the remaining IDs in the batch.
   *
   * @param ids   Array of contact IDs or KG node IDs to resolve.
   * @param includeRelationships  If false, the relationships field is skipped.
   */
  async assembleMany(
    ids: string[],
    options: { includeRelationships?: boolean } = {},
  ): Promise<AssembleManyResult> {
    const includeRelationships = options.includeRelationships ?? true;
    const entities: EntityContext[] = [];
    const unresolved: string[] = [];
    const nodeless: NodelessContact[] = [];
    const failed: AssembleManyFailedEntry[] = [];

    for (const id of ids) {
      // Cache stores full payloads (with relationships) only. Skipping the cache for
      // includeRelationships=false requests prevents a partial payload from being served
      // to a later caller that wants the full payload (and vice versa).
      try {
        const cached = includeRelationships ? this.getFromCache(id) : undefined;
        if (cached) {
          // Archival is a correctness boundary (#1707): a payload cached before
          // DreamEngine (or contact deletion) archived the node must not be served.
          // One indexed lookup per hit; if the node is gone, drop every alias and
          // fall through to assembleOneClassified so the caller gets `nodeless`.
          if (await this.isLiveKgNode(cached.entityId)) {
            entities.push(cached);
            continue;
          }
          this.clearCacheForEntity(cached.entityId);
        }

        const outcome = await this.assembleOneClassified(id, includeRelationships);
        if (outcome.kind === 'assembled') {
          if (includeRelationships) {
            this.putInCache(id, outcome.context);
          }
          entities.push(outcome.context);
        } else if (outcome.kind === 'nodeless') {
          // Deliberately not cached: a backfill or a contact merge can give this
          // contact a node at any time, and a cached verdict would keep it
          // context-free for the rest of the TTL.
          //
          // warn, not debug: prod runs at LOG_LEVEL=info, so a debug line here would
          // never fire and this whole diagnostic would be invisible in the one place
          // it matters. Same reasoning already applied to the 22P02 branch below —
          // operators need a searchable signal. This is the standing production
          // record that a real contact was addressed with no context available.
          this.logger.warn(
            { contactId: outcome.entry.contactId, cause: outcome.entry.cause },
            outcome.entry.cause === 'archived'
              ? 'entity-context: contact KG node is archived — cannot carry facts, relationships, or context'
              : 'entity-context: contact holds no KG node — cannot carry facts, relationships, or context',
          );
          nodeless.push(outcome.entry);
        } else {
          this.logger.debug({ entityId: id }, 'entity-context: ID could not be resolved to a KG node');
          unresolved.push(id);
        }
      } catch (err) {
        // Per-ID failure is non-fatal for the batch — log with full context and
        // place in `failed` so the caller can retry instead of reading absence.
        this.logger.error({ err, entityId: id }, 'entity-context: assembleOne failed — treating as failed');
        failed.push({ inputId: id, retryable: isRetryableAssemblyError(err) });
      }
    }

    return { entities, unresolved, nodeless, failed };
  }

  /**
   * Resolve a single ID to an EntityContext. Returns undefined if not found.
   * Throws on DB errors — callers should wrap in try/catch or use assembleMany().
   */
  async assembleOne(id: string, includeRelationships = true): Promise<EntityContext | undefined> {
    const result = await this.assembleOneClassified(id, includeRelationships);
    return result.kind === 'assembled' ? result.context : undefined;
  }

  /**
   * assembleOne with the reason for a miss preserved.
   *
   * `assembleOne` collapses every miss to `undefined`, which loses the distinction
   * between "no such entity" and "this contact exists but cannot hold knowledge".
   * assembleMany needs that distinction to fill its `nodeless` bucket, and gets it
   * here without issuing a second query or changing the public signature (#1694).
   */
  private async assembleOneClassified(
    id: string,
    includeRelationships = true,
  ): Promise<AssembleOutcome> {
    try {
      // Step 1: Resolve the input ID to a KG node.
      // Try contact ID first, then fall back to direct KG node ID.
      const resolved = await this.resolveInput(id);
      if (resolved.kind === 'unknown') return { kind: 'unknown' };
      if (resolved.kind === 'nodeless') {
        return {
          kind: 'nodeless',
          entry: {
            inputId: id,
            contactId: resolved.contactId,
            displayName: resolved.displayName,
            cause: resolved.cause,
          },
        };
      }
      const kgNodeId = resolved.kgNodeId;

      // Step 2: Load the KG node
      const nodeRow = await this.getKgNode(kgNodeId);
      if (!nodeRow) {
        // contacts.kg_node_id carries an FK, so a set pointer with no target row
        // should be unreachable. If it happens, a real contact is being reported as
        // unknown — log loudly rather than letting it look like an ordinary miss.
        this.logger.warn(
          { entityId: id, kgNodeId },
          'entity-context: kg_node_id points at a missing node — referential integrity issue',
        );
        return { kind: 'unknown' };
      }

      // Steps 3-6: Run assembly pipeline in parallel where safe.
      // Contact lookup + connected accounts depend on each other (need contactId),
      // so contact lookup must complete before connected accounts.
      // Facts and relationships are independent of contacts.
      const [factsResult, contactRow] = await Promise.all([
        this.getFacts(kgNodeId),
        this.getContactByKgNodeId(kgNodeId),
      ]);

      // Connected accounts require the contact record's id
      const connectedAccounts = contactRow
        ? await this.getConnectedAccounts(contactRow.id)
        : [];

      const relationships = includeRelationships
        ? await this.getRelationships(kgNodeId)
        : [];

      // Filter out KG facts whose properties.attribute matches a canonical contact
      // column, BUT only when the corresponding column on the contact row is actually
      // populated. This prevents data loss when a write fell through to the KG (e.g.
      // validation failure, DB transient error) and the canonical column stayed null —
      // suppressing the fact would make the value invisible to all consumers.
      const facts = contactRow
        ? factsResult
            .filter(({ attributeKey }) => {
              if (attributeKey === null) return true; // legacy fact, no structured key
              const canonicalField = CANONICAL_ATTRIBUTE_MAP.get(attributeKey);
              if (!canonicalField) return true; // not a canonical attribute
              // Only suppress when the column is populated — de-duplication without loss.
              return !isContactRowColumnPopulated(contactRow, canonicalField);
            })
            .map(({ attributeKey: _dropped, ...fact }) => fact)
        : factsResult.map(({ attributeKey: _dropped, ...fact }) => fact);

      const ctx: EntityContext = {
        entityId: kgNodeId,
        entityType: nodeRow.type,
        label: nodeRow.label,
        contact: contactRow
          ? {
              contactId: contactRow.id,
              displayName: contactRow.display_name,
              role: contactRow.role,
              preferredName: contactRow.preferred_name,
              title: contactRow.title,
              organization: contactRow.organization,
              primaryEmail: contactRow.primary_email,
              primaryPhone: contactRow.primary_phone,
              timezone: contactRow.timezone,
              locale: contactRow.locale,
              location: contactRow.location,
              pronouns: contactRow.pronouns,
              linkedinUrl: contactRow.linkedin_url,
              bio: contactRow.bio,
              birthday: contactRow.birthday,
            }
          : null,
        facts,
        connectedAccounts,
        relationships,
      };

      return { kind: 'assembled', context: ctx };
    } catch (err) {
      // Re-throw with the entity ID stamped in the error for upstream diagnostic logs.
      // assembleMany() catches this and logs `{ err, entityId: id }`.
      this.logger.error({ err, entityId: id }, 'entity-context: pipeline failed');
      throw err;
    }
  }

  /**
   * Invalidate all cached entries for a given entity or contact ID.
   * Called by ContactService and EntityMemory after mutations.
   *
   * Clears all cache keys associated with the entity (both the input ID used to
   * look it up and the resolved entity ID) to prevent stale hits via either path.
   */
  clearCacheForEntity(id: string): void {
    // Collect all keys that reference this entity (input ID and resolved entity ID)
    const keysToDelete = new Set<string>([id]);

    // If a cached entry under this ID exists, also collect its entityId
    const entry = this.cache.get(id);
    if (entry) {
      keysToDelete.add(entry.context.entityId);
    }

    // Also collect any keys tracked under the entityId reverse map
    const relatedKeys = this.entityToCacheKeys.get(id);
    if (relatedKeys) {
      for (const k of relatedKeys) keysToDelete.add(k);
    }

    // Delete all collected keys from both cache and reverse map
    for (const key of keysToDelete) {
      const e = this.cache.get(key);
      if (e) {
        // Clean up the reverse map for this entity
        this.entityToCacheKeys.get(e.context.entityId)?.delete(key);
      }
      this.cache.delete(key);
      this.entityToCacheKeys.delete(key);
    }
  }

  /**
   * Drop every cached payload. Called after DreamEngine archives nodes or edges
   * so a fact/relationship retired on a still-live entity does not keep assembling
   * from a TTL hit. Per-entity invalidation cannot see parent entity IDs from a
   * bulk `UPDATE kg_nodes SET archived_at`.
   */
  clearCache(): void {
    this.cache.clear();
    this.entityToCacheKeys.clear();
  }

  // -- Private helpers --

  private getFromCache(id: string): EntityContext | undefined {
    const entry = this.cache.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(id);
      this.entityToCacheKeys.get(entry.context.entityId)?.delete(id);
      return undefined;
    }
    return entry.context;
  }

  private putInCache(inputId: string, ctx: EntityContext): void {
    const now = Date.now();
    const expiresAt = now + CACHE_TTL_MS;

    // Opportunistic GC: scan for expired entries on every write.
    // Expired entries are only pruned on direct-key reads (getFromCache), so IDs that
    // are never looked up again would otherwise accumulate indefinitely in long-lived
    // processes. The scan is O(n) over the cache size; acceptable because the cache is
    // bounded to the set of entities touched in a conversation (typically <100).
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        const keys = this.entityToCacheKeys.get(entry.context.entityId);
        if (keys) {
          keys.delete(key);
          if (keys.size === 0) {
            this.entityToCacheKeys.delete(entry.context.entityId);
          }
        }
      }
    }

    // Collect all lookup keys for this entity: the input ID (may be a contact ID
    // or KG node ID), the resolved KG node ID, and — crucially — the contact ID
    // if the entity has one. Registering all three ensures that
    // clearCacheForEntity() can invalidate the entry no matter which alias was
    // used to prime the cache. Without the contact ID here, a lookup by KG node
    // ID would leave no contact-ID → KG-node reverse map entry, so a subsequent
    // clearCacheForEntity(contactId) call after a mutation would silently miss the
    // stale KG node entry.
    const allKeys = new Set([inputId, ctx.entityId]);
    if (ctx.contact) {
      allKeys.add(ctx.contact.contactId);
    }

    for (const key of allKeys) {
      this.cache.set(key, { context: ctx, expiresAt });
    }

    // Register all keys in the reverse map so invalidation can sweep them all
    if (!this.entityToCacheKeys.has(ctx.entityId)) {
      this.entityToCacheKeys.set(ctx.entityId, new Set());
    }
    for (const key of allKeys) {
      this.entityToCacheKeys.get(ctx.entityId)!.add(key);
    }
  }

  /**
   * Resolve an input ID to a KG node ID.
   *
   * Resolution priority:
   *   1. Email address → contact_channel_identities → contacts.kg_node_id
   *   2. Contact UUID → contacts.kg_node_id
   *   3. KG node UUID → kg_nodes.id directly
   *
   * Email detection uses a simple @ check. This handles the common case where
   * LLMs pass raw email addresses from CC preambles or inbox triage rather than
   * resolving to a contact UUID first.
   */
  private async resolveInput(id: string): Promise<ResolvedInput> {
    try {
      // Email address detection: if the input looks like an email address (local-part @
      // domain with at least one dot), resolve via contact_channel_identities instead of
      // UUID columns. This handles CC flows and ceo-inbox triage where the LLM passes a
      // raw email rather than a contact UUID.
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) {
        const emailResult = await this.pool.query<{
          contact_id: string;
          kg_node_id: string | null;
          display_name: string;
          node_archived: boolean | null;
        }>(
          `SELECT c.id AS contact_id, c.kg_node_id, c.display_name,
                  (n.archived_at IS NOT NULL) AS node_archived
           FROM contact_channel_identities cci
           JOIN contacts c ON c.id = cci.contact_id
           LEFT JOIN kg_nodes n ON n.id = c.kg_node_id
           WHERE cci.channel = 'email' AND LOWER(cci.channel_identifier) = LOWER($1)`,
          [id],
        );
        if (emailResult.rows.length > 0) {
          const row = emailResult.rows[0]!;
          const nodeless = classifyLinkedNode(row.kg_node_id, row.node_archived);
          if (nodeless) {
            // Use inputKind rather than the raw email — 'email' is on the pino redact list.
            this.logger.debug(
              { inputKind: 'email', contactId: row.contact_id, cause: nodeless },
              nodeless === 'archived'
                ? 'entity-context: email resolved to contact whose KG node is archived'
                : 'entity-context: email resolved to contact with no linked KG node',
            );
            return { kind: 'nodeless', contactId: row.contact_id, displayName: row.display_name, cause: nodeless };
          }
          return { kind: 'node', kgNodeId: row.kg_node_id! };
        }
        // Email not found in contact_channel_identities — unregistered contact
        this.logger.debug({ inputKind: 'email' }, 'entity-context: email not found in contact_channel_identities — treating as unresolved');
        return { kind: 'unknown' };
      }

      // Try as a contact ID first
      const contactResult = await this.pool.query<{
        kg_node_id: string | null;
        display_name: string;
        node_archived: boolean | null;
      }>(
        `SELECT c.kg_node_id, c.display_name,
                (n.archived_at IS NOT NULL) AS node_archived
         FROM contacts c
         LEFT JOIN kg_nodes n ON n.id = c.kg_node_id
         WHERE c.id = $1`,
        [id],
      );
      if (contactResult.rows.length > 0) {
        const row = contactResult.rows[0]!;
        const nodeless = classifyLinkedNode(row.kg_node_id, row.node_archived);
        // Contact exists but cannot carry context — a different answer from "no such
        // contact", and the caller needs to be able to tell them apart (#1694, #1707).
        if (nodeless) {
          this.logger.debug(
            { contactId: id, cause: nodeless },
            nodeless === 'archived'
              ? 'entity-context: contact KG node is archived'
              : 'entity-context: contact has no linked KG node',
          );
          return { kind: 'nodeless', contactId: id, displayName: row.display_name, cause: nodeless };
        }
        return { kind: 'node', kgNodeId: row.kg_node_id! };
      }

      // Try as a KG node ID directly. Live nodes assemble. Archived nodes look up
      // the owning contact (agents routinely reuse `entities[].entityId` across
      // turns) and land in `nodeless` with cause archived — the same #1694 silence
      // class as the contactIds path. Unanchored archived nodes stay unresolved.
      const nodeResult = await this.pool.query<{ id: string; archived: boolean }>(
        'SELECT id, (archived_at IS NOT NULL) AS archived FROM kg_nodes WHERE id = $1',
        [id],
      );
      if (nodeResult.rows.length > 0) {
        const nodeRow = nodeResult.rows[0]!;
        if (!nodeRow.archived) return { kind: 'node', kgNodeId: nodeRow.id };

        const owner = await this.pool.query<{ id: string; display_name: string }>(
          'SELECT id, display_name FROM contacts WHERE kg_node_id = $1',
          [id],
        );
        if (owner.rows.length > 0) {
          const contact = owner.rows[0]!;
          this.logger.debug(
            { kgNodeId: id, contactId: contact.id },
            'entity-context: archived KG node is owned by a contact',
          );
          return {
            kind: 'nodeless',
            contactId: contact.id,
            displayName: contact.display_name,
            cause: 'archived',
          };
        }
        return { kind: 'unknown' };
      }

      return { kind: 'unknown' };
    } catch (err) {
      // PostgreSQL error 22P02 = invalid_text_representation: the ID is not a valid UUID.
      // This happens when the LLM passes a hallucinated or synthetic string (e.g.
      // 'joseph-fung-contact-id', 'primary-user') to a UUID column. Treat as unresolved
      // rather than letting the error bubble up and surface to the caller.
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === '22P02'
      ) {
        // Warn rather than debug: after the contact-resolver fix ships, this path should be
        // unreachable in production. If it fires, something upstream is still leaking a
        // synthetic/hallucinated ID and operators need a searchable signal to trace it.
        this.logger.warn({ id }, 'entity-context: non-UUID id passed to resolveInput — treating as unresolved');
        return { kind: 'unknown' };
      }
      throw err;
    }
  }

  private async getKgNode(id: string): Promise<KgNodeRow | undefined> {
    const result = await this.pool.query<KgNodeRow>(
      'SELECT id, type, label, properties FROM kg_nodes WHERE id = $1 AND archived_at IS NULL',
      [id],
    );
    return result.rows[0];
  }

  /** True when the node exists and has not been archived. Used to reject stale cache hits. */
  private async isLiveKgNode(id: string): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM kg_nodes WHERE id = $1 AND archived_at IS NULL',
      [id],
    );
    return result.rows.length > 0;
  }

  /**
   * Get all fact nodes linked to the entity via 'relates_to' edges.
   * Returns an internal type that includes the raw properties.attribute key so
   * assembleOne() can filter out canonical contact facts before returning. The
   * attribute key is stripped from the public EntityFact shape.
   */
  private async getFacts(entityNodeId: string): Promise<FactWithAttribute[]> {
    const result = await this.pool.query<FactRow>(
      `SELECT n.label, n.properties, n.confidence, n.last_confirmed_at
       FROM kg_edges e
       JOIN kg_nodes n ON n.id = e.target_node_id
       WHERE e.source_node_id = $1
         AND e.type = 'relates_to'
         AND n.type = 'fact'
         AND e.archived_at IS NULL
         AND n.archived_at IS NULL
       UNION ALL
       SELECT n.label, n.properties, n.confidence, n.last_confirmed_at
       FROM kg_edges e
       JOIN kg_nodes n ON n.id = e.source_node_id
       WHERE e.target_node_id = $1
         AND e.type = 'relates_to'
         AND n.type = 'fact'
         AND e.archived_at IS NULL
         AND n.archived_at IS NULL`,
      [entityNodeId],
    );

    return result.rows.map((row) => {
      const props = (row.properties ?? {}) as Record<string, unknown>;
      const factValue = props.value;
      // Log missing value field so operators can detect malformed fact writes
      if (factValue === undefined) {
        this.logger.debug(
          { label: row.label, entityNodeId },
          'entity-context: fact node missing properties.value',
        );
      }
      // Lowercase for case-insensitive deny-list lookup in assembleOne().
      const attributeKey = typeof props.attribute === 'string'
        ? props.attribute.toLowerCase()
        : null;
      // Log when a fact has no structured attribute key — it will bypass the canonical
      // filter even if its label matches a canonical attribute (legacy write path).
      if (attributeKey === null && Object.keys(props).length > 0) {
        this.logger.debug(
          { label: row.label, entityNodeId },
          'entity-context: fact node missing properties.attribute — canonical filter cannot apply',
        );
      }
      return {
        label: row.label,
        value: factValue ?? null,
        category: String(props.category ?? 'unknown'),
        confidence: Number(row.confidence),
        lastConfirmedAt: row.last_confirmed_at instanceof Date
          ? row.last_confirmed_at.toISOString()
          : String(row.last_confirmed_at),
        attributeKey,
      };
    });
  }

  private async getContactByKgNodeId(kgNodeId: string): Promise<ContactRow | undefined> {
    const result = await this.pool.query<ContactRow>(
      `SELECT id, display_name, role,
              preferred_name, title, organization, primary_email, primary_phone,
              timezone, locale, location, pronouns, linkedin_url, bio, birthday
       FROM contacts WHERE kg_node_id = $1`,
      [kgNodeId],
    );
    return result.rows[0];
  }

  /**
   * Get all connected accounts for a contact.
   * Today: contact_calendars only. Future: union with contact_email_accounts, etc.
   */
  private async getConnectedAccounts(contactId: string): Promise<ConnectedAccount[]> {
    const calendarResult = await this.pool.query<CalendarRow>(
      `SELECT nylas_calendar_id, label, is_primary, read_only, timezone
       FROM contact_calendars
       WHERE contact_id = $1`,
      [contactId],
    );

    return calendarResult.rows.map((row) => ({
      type: 'calendar',
      label: row.label,
      serviceId: row.nylas_calendar_id,
      isPrimary: row.is_primary,
      readOnly: row.read_only,
      metadata: row.timezone ? { timezone: row.timezone } : {},
    }));
  }

  /**
   * Get first-degree relationships (depth=1) for an entity.
   * Walks all kg_edges where the entity is source or target, then fetches
   * the other end's label and type. Excludes 'fact' nodes (those go in the
   * facts array, not relationships).
   */
  private async getRelationships(entityNodeId: string): Promise<EntityRelationship[]> {
    const result = await this.pool.query<RelationshipRow>(
      `SELECT
         e.type AS edge_type,
         'outbound' AS direction,
         n.id AS related_id,
         n.label AS related_label,
         n.type AS related_type
       FROM kg_edges e
       JOIN kg_nodes n ON n.id = e.target_node_id
       WHERE e.source_node_id = $1
         AND n.type != 'fact'
         AND e.archived_at IS NULL
         AND n.archived_at IS NULL
       UNION ALL
       SELECT
         e.type AS edge_type,
         'inbound' AS direction,
         n.id AS related_id,
         n.label AS related_label,
         n.type AS related_type
       FROM kg_edges e
       JOIN kg_nodes n ON n.id = e.source_node_id
       WHERE e.target_node_id = $1
         AND n.type != 'fact'
         AND e.archived_at IS NULL
         AND n.archived_at IS NULL`,
      [entityNodeId],
    );

    return result.rows.map((row) => ({
      type: row.edge_type,
      direction: row.direction as 'outbound' | 'inbound',
      relatedEntityId: row.related_id,
      relatedEntityLabel: row.related_label,
      relatedEntityType: row.related_type,
    }));
  }
}

// -- DB row types (internal only) --

interface KgNodeRow {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
}

interface FactRow {
  label: string;
  properties: Record<string, unknown>;
  confidence: number;
  last_confirmed_at: Date | string;
}

// Internal type returned by getFacts() before the canonical-attribute filter is applied.
// attributeKey is the lowercase properties.attribute value (null for legacy facts that
// predate structured fact writes). Stripped before the EntityFact[] is returned.
type FactWithAttribute = EntityFact & { attributeKey: string | null };

interface ContactRow {
  id: string;
  display_name: string;
  role: string | null;
  // Canonical profile attributes (migration 048)
  preferred_name: string | null;
  title: string | null;
  organization: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedin_url: string | null;
  bio: string | null;
  birthday: string | null;
}

interface CalendarRow {
  nylas_calendar_id: string;
  label: string;
  is_primary: boolean;
  read_only: boolean;
  timezone: string | null;
}

interface RelationshipRow {
  edge_type: string;
  direction: string;
  related_id: string;
  related_label: string;
  related_type: string;
}

/**
 * Classify a contact's linked KG node for the nodeless bucket.
 * `nodeArchived` is the SQL `(n.archived_at IS NOT NULL)` boolean from the LEFT JOIN.
 * An unmatched join (dangling `kg_node_id`) yields `false`, not null — both are
 * treated as live so the miss still falls through to getKgNode's referential-integrity
 * warning. `true` is the only archived signal.
 */
function classifyLinkedNode(
  kgNodeId: string | null | undefined,
  nodeArchived: boolean | null | undefined,
): NodelessCause | null {
  if (!kgNodeId) return 'missing';
  if (nodeArchived === true) return 'archived';
  return null;
}

/**
 * Returns true when the ContactRow column that backs the given ContactCanonicalFields key
 * is non-null (i.e., the value has been persisted on the contact record).
 * Used by the fact filter: only suppress a canonical-keyed KG fact when its corresponding
 * column is populated — otherwise a write that fell through to the KG (e.g. validation
 * failure, transient DB error) would make the data invisible to all consumers.
 */
function isContactRowColumnPopulated(
  row: ContactRow,
  field: keyof ContactCanonicalFields,
): boolean {
  switch (field) {
    case 'preferredName': return row.preferred_name != null;
    case 'title':         return row.title != null;
    case 'organization':  return row.organization != null;
    case 'primaryEmail':  return row.primary_email != null;
    case 'primaryPhone':  return row.primary_phone != null;
    case 'timezone':      return row.timezone != null;
    case 'locale':        return row.locale != null;
    case 'location':      return row.location != null;
    case 'pronouns':      return row.pronouns != null;
    case 'linkedinUrl':   return row.linkedin_url != null;
    case 'bio':           return row.bio != null;
    case 'birthday':      return row.birthday != null;
  }
}

/**
 * Classify whether a thrown assembly error is likely transient.
 * The handler owns LLM-facing wording; this only supplies the retry signal.
 */
export function isRetryableAssemblyError(err: unknown): boolean {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    switch (code) {
      // Transient: pool pressure, timeouts, connection loss, deadlocks
      case '53300': // too_many_connections
      case '57014': // query_canceled (statement timeout)
      case '08000': // connection_exception
      case '08003': // connection_does_not_exist
      case '08006': // connection_failure
      case '40001': // serialization_failure
      case '40P01': // deadlock_detected
      case '57P03': // cannot_connect_now
        return true;
      // Permanent: schema drift, missing objects, privilege
      case '42703': // undefined_column
      case '42P01': // undefined_table
      case '42501': // insufficient_privilege
        return false;
    }
  }
  if (err instanceof TypeError) return false;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('econnreset')
      || msg.includes('connection reset')
      || msg.includes('pool timeout')
    ) {
      return true;
    }
  }
  // Unknown errors: do not invite a retry loop
  return false;
}
