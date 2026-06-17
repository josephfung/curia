// scripts/dedup-contacts.ts
//
// Contact de-duplication maintenance sweep.
//
// Implements GitHub issue #944: Contact de-duplication via entity resolution.
//
// Merge strategy:
//   - Structural pair (shared channel identity / same kg_node_id / exact name) → auto-merge
//     UNLESS either contact is the principal (system_role='principal') → task instead.
//   - Fuzzy pair (name/JW similarity) → Curia-owned task (never auto-merge).
//   - Excluded pair (dedup_exclusion KG fact) → skip entirely.
//
// Dry-run mode (--dry-run flag): reports what would happen without writing anything.
//
// Run: pnpm run dedup:contacts [--dry-run]

import pg from 'pg';
import pino from 'pino';
import { classifyPair } from '../src/contacts/dedup-classifier.js';
import type { Contact, ChannelIdentity } from '../src/contacts/types.js';
import type { KgNode } from '../src/memory/types.js';
import type { StoreFactOptions } from '../src/memory/types.js';

const logger = pino({ name: 'dedup-contacts' });

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Public types (exported for tests)
// ---------------------------------------------------------------------------

export interface DedupRunResult {
  dryRun: boolean;
  /** Number of pairs successfully auto-merged (0 in dry-run). */
  mergedCount: number;
  /** Number of fuzzy pairs that had tasks created (0 in dry-run). */
  taskCount: number;
  /** Number of pairs skipped due to dedup_exclusion facts. */
  skippedExcludedCount: number;
  /** Number of structural pairs involving the principal (routed to task instead of merge). */
  principalSkippedCount: number;
  /** Number of pairs that would have been merged (dry-run report). */
  wouldMergeCount: number;
  /** Number of pairs that would have had tasks created (dry-run report). */
  wouldCreateTaskCount: number;
  /** Number of errors during merge/task-create operations. */
  errorCount: number;
}

/** Dependency-injected callbacks used by runDedup() — allows unit testing without a DB. */
export interface DedupRunOptions {
  dryRun: boolean;
  /** Calls ContactService.mergeContacts (or equivalent). Returns a MergeResult. */
  mergeContacts: (primaryId: string, secondaryId: string) => Promise<unknown>;
  /** Calls TaskRepo.createTask (or equivalent). */
  createTask: (params: {
    agentId: string;
    title: string;
    description: string;
    owner: 'curia';
    source: 'agent';
    sourceAgentId: string;
    tags: string[];
  }) => Promise<unknown>;
  /** Calls EntityMemory.storeFact (or equivalent). */
  storeFact: (options: StoreFactOptions) => Promise<unknown>;
  /** Calls EntityMemory.getFacts for a KG node — returns fact nodes. */
  getFacts: (kgNodeId: string) => Promise<KgNode[]>;
}

// ---------------------------------------------------------------------------
// Exclusion helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface WriteExclusionOptions {
  contactAId: string;
  contactBId: string;
  /** KG node on which to record the exclusion fact. */
  kgNodeId: string;
  storeFact: (options: StoreFactOptions) => Promise<unknown>;
}

/**
 * Record a dedup_exclusion KG fact on kgNodeId naming contactBId.
 *
 * This is the memory-store path for a "do not suggest again" signal.
 * The fact uses permanent decay so it survives the normal slow/fast decay
 * schedule and is never quietly discarded.
 *
 * Format follows the convention used by backfill-contact-attributes:
 *   label: "dedup_exclusion: <otherContactId>"
 *   properties.attribute = 'dedup_exclusion'
 *   properties.value     = otherContactId
 */
export async function writeExclusion(opts: WriteExclusionOptions): Promise<void> {
  const { contactAId: _contactAId, contactBId, kgNodeId, storeFact } = opts;
  await storeFact({
    entityNodeId: kgNodeId,
    label: `dedup_exclusion: ${contactBId}`,
    properties: { attribute: 'dedup_exclusion', value: contactBId },
    // Permanent decay — exclusion decisions must not quietly expire
    decayClass: 'permanent',
    confidence: 1.0,
    source: 'contacts-dedup',
    sensitivity: 'internal',
  });
}

// ---------------------------------------------------------------------------

export interface HasExclusionOptions {
  contactAId: string;
  contactBId: string;
  kgNodeIdA: string | null;
  kgNodeIdB: string | null;
  getFacts: (kgNodeId: string) => Promise<KgNode[]>;
}

/**
 * Check whether either contact has recorded a dedup_exclusion fact naming the other.
 *
 * Returns true if an exclusion exists in either direction (A→B or B→A).
 * Returns false immediately if neither contact has a kg_node_id (no facts possible).
 */
export async function hasExclusion(opts: HasExclusionOptions): Promise<boolean> {
  const { contactAId, contactBId, kgNodeIdA, kgNodeIdB, getFacts } = opts;

  // Short-circuit: no KG nodes means no facts can exist
  if (kgNodeIdA === null && kgNodeIdB === null) return false;

  // Check A's node for an exclusion naming B
  if (kgNodeIdA !== null) {
    const factsA = await getFacts(kgNodeIdA);
    for (const fact of factsA) {
      const props = fact.properties as Record<string, unknown>;
      if (props.attribute === 'dedup_exclusion' && props.value === contactBId) {
        return true;
      }
    }
  }

  // Check B's node for an exclusion naming A
  if (kgNodeIdB !== null) {
    const factsB = await getFacts(kgNodeIdB);
    for (const fact of factsB) {
      const props = fact.properties as Record<string, unknown>;
      if (props.attribute === 'dedup_exclusion' && props.value === contactAId) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Core sweep logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Run the deduplication sweep over the supplied contacts.
 *
 * This function contains all the decision logic (structural vs fuzzy, principal
 * guard, exclusion check, dry-run) and is injected with callbacks so it can be
 * unit-tested without a real database.
 *
 * @param contacts - all active contacts to sweep
 * @param identityMap - channel identities keyed by contactId
 * @param opts - injected dependencies + dryRun flag
 */
export async function runDedup(
  contacts: Contact[],
  identityMap: Map<string, ChannelIdentity[]>,
  opts: DedupRunOptions,
): Promise<DedupRunResult> {
  const { dryRun, mergeContacts, createTask, storeFact, getFacts } = opts;

  const result: DedupRunResult = {
    dryRun,
    mergedCount: 0,
    taskCount: 0,
    skippedExcludedCount: 0,
    principalSkippedCount: 0,
    wouldMergeCount: 0,
    wouldCreateTaskCount: 0,
    errorCount: 0,
  };

  if (contacts.length < 2) return result;

  // Track pairs we've already handled to avoid double-processing (A,B) and (B,A).
  const processedPairs = new Set<string>();

  // We need a canonical ordering for pair keys
  function pairKey(aId: string, bId: string): string {
    return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
  }

  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i]!;
      const b = contacts[j]!;

      const key = pairKey(a.id, b.id);
      if (processedPairs.has(key)) continue;
      processedPairs.add(key);

      const aIdentities = identityMap.get(a.id) ?? [];
      const bIdentities = identityMap.get(b.id) ?? [];

      // Classify the pair: structural, fuzzy, or null (below threshold)
      const classification = classifyPair(a, aIdentities, b, bIdentities);
      if (classification === null) continue;

      // ------------------------------------------------------------------
      // Check for a prior dedup_exclusion in either direction
      // ------------------------------------------------------------------
      // We check regardless of classification type — exclusions apply to all matches.
      const excluded = await hasExclusion({
        contactAId: a.id,
        contactBId: b.id,
        kgNodeIdA: a.kgNodeId,
        kgNodeIdB: b.kgNodeId,
        getFacts,
      });
      if (excluded) {
        logger.debug({ contactAId: a.id, contactBId: b.id }, 'dedup: skipped — dedup_exclusion fact present');
        result.skippedExcludedCount++;
        continue;
      }

      // ------------------------------------------------------------------
      // Principal guard: never auto-merge a pair involving the principal
      // ------------------------------------------------------------------
      const involvePrincipal = a.systemRole === 'principal' || b.systemRole === 'principal';

      if (classification.type === 'structural' && !involvePrincipal) {
        // ------------------------------------------------------------------
        // Structural pair — auto-merge
        // ------------------------------------------------------------------
        // Choose the primary: prefer the contact with the lower string ID (arbitrary
        // but stable tiebreaker). In practice the contacts specialist may have a smarter
        // selection policy, but for the maintenance script determinism is more important
        // than optimal selection.
        const [primaryId, secondaryId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];

        logger.info(
          { primaryId, secondaryId, reason: classification.reason },
          'dedup: structural proof — auto-merging',
        );

        if (dryRun) {
          result.wouldMergeCount++;
          continue;
        }

        try {
          await mergeContacts(primaryId!, secondaryId!);
          result.mergedCount++;
          logger.info({ primaryId, secondaryId }, 'dedup: merge complete');
        } catch (err) {
          logger.error({ err, primaryId, secondaryId }, 'dedup: merge failed — continuing');
          result.errorCount++;
        }
      } else {
        // ------------------------------------------------------------------
        // Fuzzy pair OR structural pair involving the principal → task
        // ------------------------------------------------------------------
        // Name/embedding similarity alone is never enough to auto-merge (see design).
        // Also, any pair touching the principal must go through human review even when
        // structural proof exists — identity mistakes for the principal are too costly.
        if (involvePrincipal) {
          result.principalSkippedCount++;
          logger.info(
            { contactAId: a.id, contactBId: b.id, reason: classification.reason },
            'dedup: principal contact involved — routing to task instead of auto-merge',
          );
        } else {
          logger.info(
            { contactAId: a.id, contactBId: b.id, classification },
            'dedup: fuzzy match — creating recommendation task',
          );
        }

        if (dryRun) {
          result.wouldCreateTaskCount++;
          continue;
        }

        try {
          // The task description must include both contact IDs so the contacts specialist
          // can fetch them and decide how to proceed. Use structured JSON-like format
          // so the agent can reliably parse the IDs.
          const description = [
            `Possible duplicate contacts detected by the dedup maintenance sweep.`,
            ``,
            `Contact A ID: ${a.id}  (${a.displayName})`,
            `Contact B ID: ${b.id}  (${b.displayName})`,
            ``,
            `Match type: ${classification.type}`,
            `Reason: ${classification.reason}`,
            classification.type === 'fuzzy' ? `Score: ${classification.score.toFixed(3)}` : '',
            ``,
            involvePrincipal
              ? `NOTE: One of these contacts is the principal — this pair was intentionally withheld from auto-merge and requires manual verification.`
              : `Please verify these are the same person, then either merge them or mark them as not duplicates (which will prevent future re-surfacing).`,
          ].filter(line => line !== undefined).join('\n');

          await createTask({
            agentId: 'contacts',
            title: `Review possible duplicate: ${a.displayName} / ${b.displayName}`,
            description,
            owner: 'curia',
            source: 'agent',
            sourceAgentId: 'contacts',
            tags: ['dedup', 'contacts'],
          });
          result.taskCount++;
        } catch (err) {
          logger.error({ err, contactAId: a.id, contactBId: b.id }, 'dedup: task creation failed — continuing');
          result.errorCount++;
        }
      }
    }
  }

  logger.info(result, 'dedup: sweep complete');
  return result;
}

// ---------------------------------------------------------------------------
// DB data loading helpers
// ---------------------------------------------------------------------------

type ContactRow = {
  id: string;
  kg_node_id: string | null;
  display_name: string;
  role: string | null;
  system_role: string | null;
  status: string;
  contact_confidence: string;
  trust_level: string | null;
  last_seen_at: Date | null;
  inbound_message_count: string;
  outbound_message_count: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
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
};

type IdentityRow = {
  id: string;
  contact_id: string;
  channel: string;
  channel_identifier: string;
  label: string | null;
  verified: boolean;
  verified_at: Date | null;
  status: string;
  source: string;
  created_at: Date;
  updated_at: Date;
};

function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    kgNodeId: row.kg_node_id,
    displayName: row.display_name,
    role: row.role,
    systemRole: (row.system_role === 'principal' || row.system_role === 'agent' || row.system_role === 'system')
      ? row.system_role
      : null,
    status: row.status as Contact['status'],
    contactConfidence: Number(row.contact_confidence),
    trustLevel: row.trust_level as Contact['trustLevel'],
    lastSeenAt: row.last_seen_at,
    inboundMessageCount: Number(row.inbound_message_count),
    outboundMessageCount: Number(row.outbound_message_count),
    notes: row.notes,
    preferredName: row.preferred_name,
    title: row.title,
    organization: row.organization,
    primaryEmail: row.primary_email,
    primaryPhone: row.primary_phone,
    timezone: row.timezone,
    locale: row.locale,
    location: row.location,
    pronouns: row.pronouns,
    linkedinUrl: row.linkedin_url,
    bio: row.bio,
    birthday: row.birthday,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToIdentity(row: IdentityRow): ChannelIdentity {
  return {
    id: row.id,
    contactId: row.contact_id,
    channel: row.channel,
    channelIdentifier: row.channel_identifier,
    label: row.label,
    verified: row.verified,
    verifiedAt: row.verified_at,
    status: row.status as ChannelIdentity['status'],
    source: row.source as ChannelIdentity['source'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadContactsAndIdentities(pool: pg.Pool): Promise<{
  contacts: Contact[];
  identityMap: Map<string, ChannelIdentity[]>;
}> {
  // Load only 'confirmed' and 'provisional' contacts — skip 'blocked'.
  // Blocked contacts should not be merged; they are deliberately excluded.
  const contactsResult = await pool.query<ContactRow>(
    `SELECT id, kg_node_id, display_name, role, system_role, status, contact_confidence,
            trust_level, last_seen_at, inbound_message_count, outbound_message_count, notes,
            created_at, updated_at, preferred_name, title, organization, primary_email,
            primary_phone, timezone, locale, location, pronouns, linkedin_url, bio, birthday
     FROM contacts
     WHERE status IN ('confirmed', 'provisional')
     ORDER BY created_at ASC`,
  );
  const contacts = contactsResult.rows.map(rowToContact);

  // Load all identities for the fetched contacts in one query.
  // The contact IDs are parameterized via ANY($1) to avoid string interpolation.
  const contactIds = contacts.map(c => c.id);
  const identityMap = new Map<string, ChannelIdentity[]>();

  if (contactIds.length === 0) return { contacts, identityMap };

  const identitiesResult = await pool.query<IdentityRow>(
    `SELECT id, contact_id, channel, channel_identifier, label, verified, verified_at,
            status, source, created_at, updated_at
     FROM contact_channel_identities
     WHERE contact_id = ANY($1)
       AND status = 'active'`,
    [contactIds],
  );

  for (const row of identitiesResult.rows) {
    const identity = rowToIdentity(row);
    const existing = identityMap.get(identity.contactId);
    if (existing) {
      existing.push(identity);
    } else {
      identityMap.set(identity.contactId, [identity]);
    }
  }

  return { contacts, identityMap };
}

// ---------------------------------------------------------------------------
// KG fact helpers for use with the real pool
// ---------------------------------------------------------------------------

async function getFactsFromDb(pool: pg.Pool, kgNodeId: string): Promise<KgNode[]> {
  // Replicates the query used in EntityMemory.getFacts().
  // Returns all fact nodes reachable via a 'relates_to' edge from the given node.
  const result = await pool.query<{
    id: string;
    type: string;
    label: string;
    properties: Record<string, unknown>;
    embedding: number[] | null;
    confidence: string;
    decay_class: string;
    source: string;
    sensitivity: string;
    aliases: string[];
    created_at: Date;
    last_confirmed_at: Date;
  }>(
    `SELECT n.id, n.type, n.label, n.properties, n.embedding, n.confidence,
            n.decay_class, n.source, n.sensitivity, n.aliases,
            n.created_at, n.last_confirmed_at
     FROM kg_nodes n
     JOIN kg_edges e ON (
       (e.source_node_id = $1 AND e.target_node_id = n.id)
       OR (e.target_node_id = $1 AND e.source_node_id = n.id)
     )
     WHERE e.type = 'relates_to'
       AND e.archived_at IS NULL
       AND n.type = 'fact'
       AND n.archived_at IS NULL`,
    [kgNodeId],
  );

  return result.rows.map(row => ({
    id: row.id,
    type: row.type as KgNode['type'],
    label: row.label,
    properties: row.properties,
    embedding: row.embedding ?? undefined,
    confidence: Number(row.confidence),
    decayClass: row.decay_class as KgNode['decayClass'],
    source: row.source,
    sensitivity: row.sensitivity as KgNode['sensitivity'],
    aliases: row.aliases,
    temporal: {
      createdAt: row.created_at,
      lastConfirmedAt: row.last_confirmed_at,
    },
  }));
}

async function storeFactInDb(pool: pg.Pool, options: StoreFactOptions): Promise<void> {
  // Write a KG fact via direct SQL (no EntityMemory available in the script context
  // because EntityMemory requires EmbeddingService and MemoryValidator).
  //
  // This is intentionally minimal: we only need to write exclusion facts, which have
  // a known schema (attribute/value properties, permanent decay). If a full EntityMemory
  // is needed in future the script can be wired with real DI.
  //
  // The label "dedup_exclusion: <id>" is short, ascii-only — no embedding needed.
  // We insert with embedding = NULL (allowed; the vector column is nullable).
  await pool.query(
    `INSERT INTO kg_nodes (
       type, label, properties, confidence, decay_class, source, sensitivity,
       aliases, created_at, last_confirmed_at
     ) VALUES (
       'fact', $1, $2, $3, $4, $5, $6, '{}', NOW(), NOW()
     )`,
    [
      options.label,
      JSON.stringify(options.properties ?? {}),
      options.confidence ?? 0.7,
      options.decayClass ?? 'permanent',
      options.source,
      options.sensitivity ?? 'internal',
    ],
  );
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    logger.error('dedup-contacts: DATABASE_URL is not set');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    logger.info('dedup-contacts: running in DRY-RUN mode — no writes will be made');
  }

  const pool = new Pool({ connectionString: databaseUrl });

  (async () => {
    try {
      const { contacts, identityMap } = await loadContactsAndIdentities(pool);
      logger.info({ contactCount: contacts.length }, 'dedup-contacts: loaded contacts');

      // Build injected callbacks for the real pool
      const opts: DedupRunOptions = {
        dryRun,

        mergeContacts: async (primaryId, secondaryId) => {
          // Direct SQL merge: re-attach identities, update primary, delete secondary.
          // Reuses the same logic as ContactService.mergeContacts but without the full
          // service stack. The contact.merged bus event (which fires the audit log) is
          // NOT emitted here — the maintenance script runs outside the bus context.
          // TODO: Thread the bus through the script if audit coverage of batch merges is required.
          await pool.query(
            `UPDATE contact_channel_identities SET contact_id = $1 WHERE contact_id = $2`,
            [primaryId, secondaryId],
          );
          await pool.query(
            `UPDATE contact_auth_overrides SET contact_id = $1 WHERE contact_id = $2`,
            [primaryId, secondaryId],
          );
          await pool.query(
            `DELETE FROM contacts WHERE id = $1`,
            [secondaryId],
          );
          logger.info({ primaryId, secondaryId }, 'dedup-contacts: merged via SQL');
        },

        createTask: async (params) => {
          // Insert a task directly. The heartbeat will route Curia-owned tasks
          // with source_agent_id='contacts' to the contacts specialist.
          const { rows } = await pool.query(
            `INSERT INTO tasks (
               agent_id, title, description, status, progress, error_budget,
               owner, source, source_agent_id, tags, priority, created_at, updated_at,
               intent_anchor, created_by
             ) VALUES (
               $1, $2, $3, 'open', '{"notes":[]}'::jsonb, '{}'::jsonb,
               $4, $5, $6, $7, 50, NOW(), NOW(), $2, $1
             )
             RETURNING id`,
            [
              params.agentId,
              params.title,
              params.description,
              params.owner,
              params.source,
              params.sourceAgentId,
              params.tags,
            ],
          );
          logger.info({ taskId: rows[0]?.id, title: params.title }, 'dedup-contacts: task created');
          return rows[0];
        },

        storeFact: async (options) => {
          await storeFactInDb(pool, options);
        },

        getFacts: async (kgNodeId) => {
          return getFactsFromDb(pool, kgNodeId);
        },
      };

      const result = await runDedup(contacts, identityMap, opts);

      // Summary report
      if (dryRun) {
        logger.info({
          wouldMergeCount: result.wouldMergeCount,
          wouldCreateTaskCount: result.wouldCreateTaskCount,
          skippedExcludedCount: result.skippedExcludedCount,
          principalSkippedCount: result.principalSkippedCount,
        }, 'dedup-contacts: DRY-RUN complete (no changes made)');
      } else {
        logger.info({
          mergedCount: result.mergedCount,
          taskCount: result.taskCount,
          skippedExcludedCount: result.skippedExcludedCount,
          principalSkippedCount: result.principalSkippedCount,
          errorCount: result.errorCount,
        }, 'dedup-contacts: sweep complete');
      }

      await pool.end();
      process.exit(result.errorCount > 0 ? 1 : 0);
    } catch (err) {
      logger.error({ err }, 'dedup-contacts: fatal error');
      await pool.end();
      process.exit(1);
    }
  })();
}
