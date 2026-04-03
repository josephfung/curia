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
// on one entity doesn't abort the entire batch — failed IDs are logged and placed
// in the `unresolved` array rather than propagating.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { EntityContext, EntityFact, ConnectedAccount, EntityRelationship } from './types.js';

// TTL for cached entity context payloads (5 minutes per spec).
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  context: EntityContext;
  expiresAt: number;
}

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
   *   1. Matches a contacts.id → look up kg_node_id, assemble from that KG node
   *   2. Matches a kg_nodes.id directly → assemble from that KG node
   *   3. No match → included in `unresolved` (not a hard error)
   *
   * Each ID is assembled independently; a DB error on one ID logs a warning and
   * adds the ID to `unresolved` without aborting the remaining IDs in the batch.
   *
   * @param ids   Array of contact IDs or KG node IDs to resolve.
   * @param includeRelationships  If false, the relationships field is skipped.
   */
  async assembleMany(
    ids: string[],
    options: { includeRelationships?: boolean } = {},
  ): Promise<{ entities: EntityContext[]; unresolved: string[] }> {
    const includeRelationships = options.includeRelationships ?? true;
    const entities: EntityContext[] = [];
    const unresolved: string[] = [];

    for (const id of ids) {
      // Cache stores full payloads (with relationships) only. Skipping the cache for
      // includeRelationships=false requests prevents a partial payload from being served
      // to a later caller that wants the full payload (and vice versa).
      const cached = includeRelationships ? this.getFromCache(id) : undefined;
      if (cached) {
        entities.push(cached);
        continue;
      }

      try {
        const ctx = await this.assembleOne(id, includeRelationships);
        if (ctx) {
          if (includeRelationships) {
            this.putInCache(id, ctx);
          }
          entities.push(ctx);
        } else {
          this.logger.debug({ entityId: id }, 'entity-context: ID could not be resolved to a KG node');
          unresolved.push(id);
        }
      } catch (err) {
        // Per-ID failure is non-fatal for the batch — log with full context and
        // treat as unresolved so the caller gets partial results instead of nothing.
        this.logger.error({ err, entityId: id }, 'entity-context: assembleOne failed — treating as unresolved');
        unresolved.push(id);
      }
    }

    return { entities, unresolved };
  }

  /**
   * Resolve a single ID to an EntityContext. Returns undefined if not found.
   * Throws on DB errors — callers should wrap in try/catch or use assembleMany().
   */
  async assembleOne(id: string, includeRelationships = true): Promise<EntityContext | undefined> {
    try {
      // Step 1: Resolve the input ID to a KG node.
      // Try contact ID first, then fall back to direct KG node ID.
      const kgNodeId = await this.resolveKgNodeId(id);
      if (!kgNodeId) return undefined;

      // Step 2: Load the KG node
      const nodeRow = await this.getKgNode(kgNodeId);
      if (!nodeRow) return undefined;

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

      const ctx: EntityContext = {
        entityId: kgNodeId,
        entityType: nodeRow.type,
        label: nodeRow.label,
        contact: contactRow
          ? { contactId: contactRow.id, displayName: contactRow.display_name, role: contactRow.role }
          : null,
        facts: factsResult,
        connectedAccounts,
        relationships,
      };

      return ctx;
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
   * Tries contacts.id first, then kg_nodes.id directly.
   */
  private async resolveKgNodeId(id: string): Promise<string | undefined> {
    try {
      // Try as a contact ID first
      const contactResult = await this.pool.query<{ kg_node_id: string | null }>(
        'SELECT kg_node_id FROM contacts WHERE id = $1',
        [id],
      );
      if (contactResult.rows.length > 0) {
        const row = contactResult.rows[0];
        const kgNodeId = row?.kg_node_id;
        // Contact found but has no linked KG node — return undefined (unresolved)
        if (!kgNodeId) {
          this.logger.debug({ contactId: id }, 'entity-context: contact has no linked KG node');
          return undefined;
        }
        return kgNodeId;
      }

      // Try as a KG node ID directly
      const nodeResult = await this.pool.query<{ id: string }>(
        'SELECT id FROM kg_nodes WHERE id = $1',
        [id],
      );
      if (nodeResult.rows.length > 0) {
        return nodeResult.rows[0]?.id;
      }

      return undefined;
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
        this.logger.warn({ id }, 'entity-context: non-UUID id passed to resolveKgNodeId — treating as unresolved');
        return undefined;
      }
      throw err;
    }
  }

  private async getKgNode(id: string): Promise<KgNodeRow | undefined> {
    const result = await this.pool.query<KgNodeRow>(
      'SELECT id, type, label, properties FROM kg_nodes WHERE id = $1',
      [id],
    );
    return result.rows[0];
  }

  /**
   * Get all fact nodes linked to the entity via 'relates_to' edges.
   * Fact nodes have type = 'fact' and carry value/category in their properties.
   */
  private async getFacts(entityNodeId: string): Promise<EntityFact[]> {
    const result = await this.pool.query<FactRow>(
      `SELECT n.label, n.properties, n.confidence, n.last_confirmed_at
       FROM kg_edges e
       JOIN kg_nodes n ON n.id = e.target_node_id
       WHERE e.source_node_id = $1
         AND e.type = 'relates_to'
         AND n.type = 'fact'
       UNION ALL
       SELECT n.label, n.properties, n.confidence, n.last_confirmed_at
       FROM kg_edges e
       JOIN kg_nodes n ON n.id = e.source_node_id
       WHERE e.target_node_id = $1
         AND e.type = 'relates_to'
         AND n.type = 'fact'`,
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
      return {
        label: row.label,
        value: factValue ?? null,
        category: String(props.category ?? 'unknown'),
        confidence: Number(row.confidence),
        lastConfirmedAt: row.last_confirmed_at instanceof Date
          ? row.last_confirmed_at.toISOString()
          : String(row.last_confirmed_at),
      };
    });
  }

  private async getContactByKgNodeId(kgNodeId: string): Promise<ContactRow | undefined> {
    const result = await this.pool.query<ContactRow>(
      'SELECT id, display_name, role FROM contacts WHERE kg_node_id = $1',
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
         AND n.type != 'fact'`,
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

interface ContactRow {
  id: string;
  display_name: string;
  role: string | null;
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
