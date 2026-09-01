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
//   - Excluded pair (row in contact_dedup_exclusions) → skip entirely.
//
// Dry-run mode (--dry-run flag): reports what would happen without writing anything.
//
// Run: pnpm run dedup:contacts [--dry-run]

import pg from 'pg';
import { createLogger } from '../src/logger.js';
import { classifyPair, type PairClassification } from '../src/contacts/dedup-classifier.js';
import type { Contact, ChannelIdentity, ContactKind } from '../src/contacts/types.js';
import {
  canonicalPairKey,
  dedupPairTag,
  pairKeyFromDedupTask,
} from '../src/contacts/dedup-pair-key.js';
import { ModelRegistry } from '../src/agents/llm/model-registry.js';
import { EventBus } from '../src/bus/bus.js';
import { AuditLogger } from '../src/audit/logger.js';
import { EmbeddingService } from '../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../src/memory/knowledge-graph.js';
import { MemoryValidator } from '../src/memory/validation.js';
import { EntityMemory } from '../src/memory/entity-memory.js';
import { ContactService } from '../src/contacts/contact-service.js';
import { TaskRepo } from '../src/db/task-repo.js';
import { DedupService } from '../src/contacts/dedup-service.js';
import { createContactMerged } from '../src/bus/events.js';

// Use the same structured logger factory as the rest of the app so log output
// lands in curia.log in dev and JSON-to-stdout in production.
const logger = createLogger();
logger.info({ name: 'dedup-contacts' }, 'dedup-contacts starting');

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
  /** Number of pairs skipped due to a recorded dedup exclusion. */
  skippedExcludedCount: number;
  /** Number of pairs skipped because an open dedup review task already exists. */
  skippedExistingCount: number;
  /** Number of structural pairs involving the principal (routed to task instead of merge). */
  principalSkippedCount: number;
  /** Number of pairs that would have been merged (dry-run report). */
  wouldMergeCount: number;
  /** Number of pairs that would have had tasks created (dry-run report). */
  wouldCreateTaskCount: number;
  /** Number of fuzzy pairs skipped because their score was below the sweep's --min-score. */
  skippedLowScoreCount: number;
  /** Number of fuzzy pairs skipped because their score was at/above the sweep's --max-score. */
  skippedAboveMaxScoreCount: number;
  /** Number of would-be review tasks suppressed by --no-tasks or the --max-tasks cap. */
  suppressedTaskCount: number;
  /** Number of pairs that failed and were skipped fail-closed. Three sources:
   *  pair classification, contact merge, and review-task creation. */
  errorCount: number;
}

/** Dependency-injected callbacks used by runDedup() — allows unit testing without a DB. */
export interface DedupRunOptions {
  dryRun: boolean;
  /**
   * Sweep-local minimum score for FUZZY matches (0–1). Fuzzy pairs scoring below this
   * are skipped (counted in skippedLowScoreCount). Does NOT affect structural matches and
   * does NOT change the global DedupService THRESHOLD_PROBABLE — it only raises the bar for
   * this maintenance run. Undefined = accept whatever the classifier returns (≥ 0.7).
   */
  minScore?: number;
  /**
   * Sweep-local maximum score for FUZZY matches — pairs scoring AT/ABOVE this are skipped
   * (counted in skippedAboveMaxScoreCount). Pairs with `minScore ≤ score < maxScore` are
   * acted on. Used for incremental band runs: a later, lower `--min-score` pass sets
   * `--max-score` to the previous run's `--min-score` so it doesn't re-create tasks for
   * pairs the earlier run already surfaced. Undefined = no upper bound.
   */
  maxScore?: number;
  /**
   * Hard cap on the number of review tasks this sweep creates. Once reached, further
   * would-be tasks are skipped (counted in suppressedTaskCount). Undefined = no cap.
   */
  maxTasks?: number;
  /**
   * Merge-only mode: apply structural auto-merges but create NO review tasks (every
   * would-be task is counted in suppressedTaskCount). Equivalent to maxTasks = 0.
   */
  noTasks?: boolean;
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
  /** Open dedup review tasks for idempotency checks. Omit in unit tests that don't need it. */
  listOpenDedupTasks?: () => Promise<Array<{ tags?: string[]; description?: string | null }>>;
  /**
   * Every recorded exclusion as a canonical pair key (ContactService.listDedupExclusionPairKeys).
   * Loaded once per run, before the O(n²) pair loop — one query instead of a lookup per pair.
   *
   * The sweep never WRITES exclusions: decline→exclude goes through the contacts agent
   * calling contact-dedup-exclude. A failure here aborts the whole sweep (fail closed) —
   * proceeding with an empty set would auto-merge pairs the CEO ruled apart.
   */
  listExclusionPairKeys: () => Promise<Set<string>>;
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
  const { dryRun, mergeContacts, createTask, listExclusionPairKeys, minScore, maxScore, maxTasks, noTasks, listOpenDedupTasks } = opts;

  const result: DedupRunResult = {
    dryRun,
    mergedCount: 0,
    taskCount: 0,
    skippedExcludedCount: 0,
    skippedExistingCount: 0,
    principalSkippedCount: 0,
    wouldMergeCount: 0,
    wouldCreateTaskCount: 0,
    skippedLowScoreCount: 0,
    skippedAboveMaxScoreCount: 0,
    suppressedTaskCount: 0,
    errorCount: 0,
  };

  if (contacts.length < 2) return result;

  // Load exclusions before any pair is classified. The sweep never WRITES exclusions,
  // so one bulk read covers the entire O(n²) loop. An error propagates and aborts the
  // sweep — see listExclusionPairKeys' doc comment.
  const excludedPairKeys = await listExclusionPairKeys();
  logger.debug({ exclusions: excludedPairKeys.size }, 'dedup: loaded recorded exclusions');

  /**
   * Mirror ContactService.reattachDedupExclusions onto the in-memory snapshot after a
   * merge. The sweep does not write exclusions, but it does MERGE, and a merge re-points
   * the secondary's exclusion rows onto the survivor. Without this the snapshot goes
   * stale mid-run and a transitively-inherited exclusion is invisible to later pairs:
   *
   *   c1, c2, c3 all named "Seth Berman"; the CEO ruled c2 ≠ c3.
   *   (c1, c2) merges structurally on exact name → the DB row becomes (c1, c3).
   *   (c1, c3) is then checked against a snapshot that still says (c2, c3) → miss →
   *   auto-merged, silently overriding the CEO's ruling.
   *
   * Applied in dry-run too, so the preview reports what a real run would actually do.
   */
  function reattachExclusionsInSnapshot(primaryId: string, secondaryId: string): void {
    for (const excludedKey of [...excludedPairKeys]) {
      const [x, y] = excludedKey.split(':') as [string, string];
      if (x !== secondaryId && y !== secondaryId) continue;

      excludedPairKeys.delete(excludedKey);
      const other = x === secondaryId ? y : x;
      // The exclusion between the two merged contacts is superseded by the merge
      // itself — the DB drops it for the same reason.
      if (other === primaryId) continue;
      excludedPairKeys.add(canonicalPairKey(primaryId, other));
    }
  }

  const existingPairKeys = new Set<string>();
  if (listOpenDedupTasks) {
    const existingTasks = await listOpenDedupTasks();
    for (const task of existingTasks) {
      const key = pairKeyFromDedupTask(task);
      if (key) existingPairKeys.add(key);
    }
  }

  // Track pairs we've already handled to avoid double-processing (A,B) and (B,A).
  const processedPairs = new Set<string>();

  // F2: Track contacts that have been merged away (deleted) so we can skip
  // subsequent pairs that reference them. Without this guard, a pair (c2, c3)
  // would attempt to merge a row that was already deleted by the (c1, c2) merge.
  const mergedAwayIds = new Set<string>();

  // We need a canonical ordering for pair keys
  function pairKey(aId: string, bId: string): string {
    return canonicalPairKey(aId, bId);
  }

  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i]!;
      const b = contacts[j]!;

      // F2: Skip if either contact was already merged away in a prior iteration.
      // This can happen when c1≡c2 (structural, merged) and c2≡c3 (structural):
      // after the c1/c2 merge, c2 is deleted — trying to merge c2 again would
      // hit a DB constraint or a silent no-op depending on the implementation.
      if (mergedAwayIds.has(a.id) || mergedAwayIds.has(b.id)) continue;

      const key = pairKey(a.id, b.id);
      if (processedPairs.has(key)) continue;
      processedPairs.add(key);

      const aIdentities = identityMap.get(a.id) ?? [];
      const bIdentities = identityMap.get(b.id) ?? [];

      // F4: Wrap classification in a try-catch so that an error on one pair does not
      // abort the entire sweep. On error we FAIL CLOSED: the pair is skipped (never
      // merged) and errorCount is incremented so the operator knows something went wrong.
      let classification: PairClassification | null;
      try {
        // Classify the pair: structural, fuzzy, or null (below threshold)
        classification = classifyPair(a, aIdentities, b, bIdentities);
      } catch (err) {
        logger.error(
          { err, contactAId: a.id, contactBId: b.id },
          'dedup: error during classification — skipping pair (fail closed)',
        );
        result.errorCount++;
        continue;
      }
      if (classification === null) continue;

      // ------------------------------------------------------------------
      // Check for a prior exclusion (order-independent)
      // ------------------------------------------------------------------
      // We check regardless of classification type — exclusions apply to all matches.
      if (excludedPairKeys.has(key)) {
        logger.debug({ contactAId: a.id, contactBId: b.id }, 'dedup: skipped — pair has a recorded exclusion');
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
        // Choose the survivor (primary). mergeContacts() keeps the primary row and only
        // merges KG nodes when BOTH contacts have one; if the primary has no kg_node_id and
        // the secondary does, the secondary's KG linkage is deleted with it (the survivor
        // ends up with no KG node). So when exactly one side has a kg_node_id, that side
        // MUST be the survivor. When both or neither have a KG node, fall back to the lower
        // string ID — an arbitrary but stable, deterministic tiebreaker.
        const aHasKg = a.kgNodeId !== null;
        const bHasKg = b.kgNodeId !== null;
        const [primaryId, secondaryId] =
          aHasKg !== bHasKg
            ? (aHasKg ? [a.id, b.id] : [b.id, a.id])
            : (a.id < b.id ? [a.id, b.id] : [b.id, a.id]);

        logger.info(
          { primaryId, secondaryId, reason: classification.reason },
          'dedup: structural proof — auto-merging',
        );

        if (dryRun) {
          result.wouldMergeCount++;
          // M3: mirror real control flow in dry-run — mark the would-be secondary
          // as merged away so later pairs referencing it are skipped, keeping the
          // dry-run counts and recommendations accurate (no double-counting a
          // contact that a real run would already have removed).
          mergedAwayIds.add(secondaryId!);
          reattachExclusionsInSnapshot(primaryId!, secondaryId!);
          continue;
        }

        try {
          await mergeContacts(primaryId!, secondaryId!);
          result.mergedCount++;
          // F2: Record the deleted (secondary) contact as merged away so that any
          // subsequent pair referencing it is skipped. This prevents attempting to
          // merge an already-deleted row (e.g. c2 appears in both (c1,c2) and (c2,c3)).
          mergedAwayIds.add(secondaryId!);
          // M4: reflect the DB-side identity reattachment in memory. mergeContacts
          // moves the secondary's channel identities onto the primary, so later pairs
          // (primaryId, X) must see the combined identity set to catch transitive
          // structural merges that only become provable after this merge consolidates
          // identities. Without this, the in-memory identityMap stays stale.
          const mergedIdentities = [
            ...(identityMap.get(primaryId!) ?? []),
            ...(identityMap.get(secondaryId!) ?? []),
          ];
          identityMap.set(primaryId!, mergedIdentities);
          identityMap.delete(secondaryId!);
          // Same reasoning as identityMap above, for exclusions: mergeContacts has just
          // re-pointed the secondary's exclusion rows onto the primary in the DB, so the
          // snapshot the remaining pairs are checked against must follow.
          reattachExclusionsInSnapshot(primaryId!, secondaryId!);
          logger.info({ primaryId, secondaryId }, 'dedup: merge complete');
        } catch (err) {
          logger.error({ err, primaryId, secondaryId }, 'dedup: merge failed — continuing');
          result.errorCount++;
        }
      } else {
        // Sweep-local score band: drop FUZZY pairs outside [minScore, maxScore) before any
        // task accounting. Structural+principal pairs are always surfaced (the principal
        // guard is about safety, not similarity score). This filters this sweep only — the
        // global DedupService threshold is untouched.
        //   --min-score: skip below the bar (too weak to review this run)
        //   --max-score: skip at/above the bar — for incremental band runs, so a
        //     lower-threshold pass doesn't re-create tasks for pairs an earlier, higher-bar
        //     run already surfaced.
        if (classification.type === 'fuzzy' && minScore !== undefined && classification.score < minScore) {
          result.skippedLowScoreCount++;
          continue;
        }
        if (classification.type === 'fuzzy' && maxScore !== undefined && classification.score >= maxScore) {
          result.skippedAboveMaxScoreCount++;
          continue;
        }

        // principalSkippedCount counts ONLY structural pairs withheld from auto-merge by the
        // principal guard (see the DedupRunResult contract). It records the MERGE decision,
        // so it is incremented even if the resulting task is later suppressed. A fuzzy pair
        // involving the principal would never auto-merge anyway, so it must not inflate this.
        if (classification.type === 'structural' && involvePrincipal) {
          result.principalSkippedCount++;
        }

        if (existingPairKeys.has(key)) {
          result.skippedExistingCount++;
          continue;
        }

        // --no-tasks (merge-only) or the --max-tasks cap: suppress task creation. Compare
        // against tasks already acted on (real run: taskCount; dry-run: wouldCreateTaskCount)
        // so the cap behaves identically in both modes and the dry-run preview reflects
        // exactly what a real run with the same flags would create.
        const tasksActedOn = dryRun ? result.wouldCreateTaskCount : result.taskCount;
        if (noTasks || (maxTasks !== undefined && tasksActedOn >= maxTasks)) {
          result.suppressedTaskCount++;
          continue;
        }

        // Past the suppression gate: a task WILL be created (real) or counted (dry-run).
        // Log here — NOT before the gate — so a suppressed pair never logs a misleading
        // "creating ... task" line (a --no-tasks run previously printed one per pair).
        logger.info(
          { contactAId: a.id, contactBId: b.id, classification, involvePrincipal },
          involvePrincipal
            ? 'dedup: principal pair — creating review task (no auto-merge)'
            : 'dedup: fuzzy match — creating review task',
        );

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
            tags: ['dedup', 'contacts', dedupPairTag(a.id, b.id)],
          });
          result.taskCount++;
          existingPairKeys.add(key);
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
  tier: string;
  kind: string | null;
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

const VALID_CONTACT_KINDS: ContactKind[] = ['person', 'organization', 'automated', 'principal', 'agent'];

// Validates the raw DB kind value against the known enum. Defaults to 'person' with a
// warning log for null or unrecognized values (e.g. pre-backfill rows), consistent with
// the validation in ContactService.rowToContact. Without this, unvalidated null/legacy
// kind values silently skip the org single-token structural exemption in the classifier.
function parseContactKind(contactId: string, raw: string | null): ContactKind {
  if (raw !== null && (VALID_CONTACT_KINDS as string[]).includes(raw)) {
    return raw as ContactKind;
  }
  logger.warn({ contactId, rawKind: raw }, 'dedup-contacts: unrecognized kind value — defaulting to person; check kind backfill for this contact');
  return 'person';
}

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
    tier: row.tier as Contact['tier'],
    kind: parseContactKind(row.id, row.kind),
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
    `SELECT id, kg_node_id, display_name, role, system_role, status, tier, kind, contact_confidence,
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
// CLI argument helpers
// ---------------------------------------------------------------------------

/**
 * Parse a numeric CLI flag supporting both `--flag value` and `--flag=value`.
 * Returns undefined if the flag is absent. Exits the process with a clear error if
 * the flag is present but its value is missing or not a finite number — better to
 * fail loudly than to silently ignore an operator's tuning intent on a prod sweep.
 */
export function parseNumericFlag(argv: string[], flag: string): number | undefined {
  const eq = argv.find(a => a.startsWith(`${flag}=`));
  let raw: string | undefined;
  if (eq) {
    raw = eq.slice(flag.length + 1);
  } else {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    raw = argv[idx + 1];
  }
  // Empty / whitespace-only values (e.g. `--min-score=` or `--max-tasks= `) must fail
  // loudly, NOT be silently coerced to 0 — Number('') and Number('  ') are both 0, which
  // is finite, so without this guard a missing operator value would pass as a real 0
  // setting (e.g. `--max-tasks=` would behave like --no-tasks).
  const n = (raw === undefined || raw.trim() === '') ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    logger.error({ flag, raw }, `dedup-contacts: ${flag} requires a numeric value`);
    process.exit(1);
  }
  return n;
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

  // Sweep-local tuning flags — these tune THIS run only; the global DedupService
  // threshold is never changed. See DedupRunOptions for semantics.
  //   --no-tasks       merge-only: apply structural merges, create no review tasks
  //   --min-score <n>  only create fuzzy tasks at/above this Jaro-Winkler score (0–1)
  //   --max-score <n>  only create fuzzy tasks BELOW this score (incremental band runs)
  //   --max-tasks <n>  cap the number of review tasks created this run
  const noTasks = process.argv.includes('--no-tasks');
  const minScore = parseNumericFlag(process.argv, '--min-score');
  const maxScore = parseNumericFlag(process.argv, '--max-score');
  const maxTasks = parseNumericFlag(process.argv, '--max-tasks');

  if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
    logger.error({ minScore }, 'dedup-contacts: --min-score must be between 0 and 1');
    process.exit(1);
  }
  if (maxScore !== undefined && (maxScore < 0 || maxScore > 1)) {
    logger.error({ maxScore }, 'dedup-contacts: --max-score must be between 0 and 1');
    process.exit(1);
  }
  if (minScore !== undefined && maxScore !== undefined && minScore >= maxScore) {
    logger.error({ minScore, maxScore }, 'dedup-contacts: --min-score must be less than --max-score (empty band otherwise)');
    process.exit(1);
  }
  if (maxTasks !== undefined && (maxTasks < 0 || !Number.isInteger(maxTasks))) {
    logger.error({ maxTasks }, 'dedup-contacts: --max-tasks must be a non-negative integer');
    process.exit(1);
  }

  if (dryRun) {
    logger.info('dedup-contacts: running in DRY-RUN mode — no writes will be made');
  }
  if (noTasks) {
    logger.info('dedup-contacts: --no-tasks — merge-only; no review tasks will be created');
  }
  if (minScore !== undefined) {
    logger.info({ minScore }, 'dedup-contacts: --min-score active — fuzzy pairs below this score are skipped');
  }
  if (maxScore !== undefined) {
    logger.info({ maxScore }, 'dedup-contacts: --max-score active — fuzzy pairs at/above this score are skipped');
  }
  if (maxTasks !== undefined) {
    logger.info({ maxTasks }, 'dedup-contacts: --max-tasks active — review tasks capped');
  }

  const pool = new Pool({ connectionString: databaseUrl });

  (async () => {
    try {
      const { contacts, identityMap } = await loadContactsAndIdentities(pool);
      logger.info({ contactCount: contacts.length }, 'dedup-contacts: loaded contacts');

      // Wire the real service stack — mirrors the construction order in src/index.ts.
      // Every injected callback delegates to a real service, no hand-rolled SQL:
      //   - mergeContacts: uses ContactService.mergeContacts(), which repoints kg_node_id,
      //     contact_calendars and dedup exclusions, and fires the contact.merged bus event
      //     (audit-logged by the write-ahead hook in EventBus). Its contact writes run in
      //     one transaction (#1695), so a failed merge rolls back whole and rethrows — the
      //     sweep can treat it as "this pair did not merge", with no partial state to
      //     reconcile. The KG node merge it attempts first is best-effort and outside that
      //     transaction.
      //   - createTask: uses TaskRepo.createTask(), which publishes task.created events.
      //   - listExclusionPairKeys: reads contact_dedup_exclusions via ContactService.
      // A real sweep merges KG entity nodes (entityMemory.mergeEntities), which embeds fact
      // labels and therefore needs OpenAI credentials. A dry-run never embeds, so it can run
      // with a fake embedding backend and no API key — keeping the preview usable in CI /
      // minimal environments. Fail fast only for a real run.
      const openaiApiKey = process.env['OPENAI_API_KEY'];
      if (!dryRun && !openaiApiKey) {
        logger.error('dedup-contacts: OPENAI_API_KEY is required for a real sweep (KG entity merge embeds fact labels). Re-run with --dry-run to preview without it.');
        process.exit(1);
      }

      const auditLogger = new AuditLogger(pool, logger);
      // EventBus with write-ahead audit hook — every published event (incl. contact.merged)
      // is persisted to audit_log before delivery, satisfying the acceptance criterion.
      const bus = new EventBus(
        logger,
        (e) => auditLogger.log(e),
        (id) => auditLogger.markAcknowledged(id),
      );

      const modelRegistry = new ModelRegistry(logger);
      // With a key, use the real OpenAI-backed embeddings. Without one (dry-run only — the
      // check above exits a real run that lacks a key), fall back to the fake backend; the
      // dry-run path never embeds, so its results are unaffected.
      const embeddingService = openaiApiKey
        ? EmbeddingService.createWithOpenAI(openaiApiKey, logger, bus, modelRegistry)
        : EmbeddingService.createForTesting();
      const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
      const validator = new MemoryValidator(kgStore, embeddingService);
      const entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);

      // contact.merged publishes are async (the write-ahead audit hook persists them).
      // onContactMerged is a SYNC callback, so we can't await inside it — instead we collect
      // each publish promise and drain them (below) BEFORE pool.end()/exit. Without this, the
      // last merge's audit insert can lose the race against process.exit and never persist
      // (observed: 14 merges → 13 audit rows on the first prod run).
      const pendingMergePublishes: Promise<void>[] = [];
      let auditPublishFailures = 0;

      const dedupService = new DedupService();
      const contactService = ContactService.createWithPostgres(pool, entityMemory, logger, {
        dedupService,
        // Publish contact.merged to the bus so the write-ahead audit hook records it.
        onContactMerged: (primaryContactId, secondaryContactId, mergedAt) => {
          pendingMergePublishes.push(
            bus.publish('dispatch', createContactMerged({ primaryContactId, secondaryContactId, mergedAt }))
              .then(() => undefined)
              .catch((err: unknown) => {
                auditPublishFailures++;
                logger.error(
                  { err, primaryContactId, secondaryContactId },
                  'Failed to publish contact.merged — audit trail may be incomplete',
                );
              }),
          );
        },
      });

      const taskRepo = new TaskRepo(pool, bus, logger, process.env['TZ'] ?? 'UTC');

      // Build injected callbacks — all delegate to real services, no hand-rolled SQL
      const opts: DedupRunOptions = {
        dryRun,
        // Sweep-local tuning (see DedupRunOptions) — passed straight through.
        minScore,
        maxScore,
        maxTasks,
        noTasks,

        // ContactService.mergeContacts handles: identity dedup (resolves the unique-email
        // constraint violation the old UPDATE would have caused), auth-override and
        // dedup-exclusion re-pointing, golden-record field consolidation, and deletion of
        // the loser row — all in one transaction since #1695. The KG entity merge it
        // attempts first is best-effort and sits outside that transaction, and the loser's
        // contact_calendars rows cascade away with the row rather than being reattached.
        mergeContacts: (primaryId, secondaryId) => contactService.mergeContacts(primaryId, secondaryId, false),

        // TaskRepo.createTask publishes task.created and handles progress/error_budget cols.
        createTask: (params) => taskRepo.createTask(params),

        listOpenDedupTasks: async () => {
          const limit = 1000;
          const tasks = await taskRepo.listTasks({
            statuses: ['open', 'in_progress', 'waiting', 'blocked'],
            tag: 'dedup',
            limit,
          });
          // Hitting the ceiling means the idempotency set is truncated — pairs beyond
          // this page may be re-filed. Mirror the warning already documented on the
          // skill's EXISTING_TASK_FETCH_LIMIT.
          if (tasks.length >= limit) {
            logger.warn(
              { count: tasks.length, limit },
              'dedup: open-task fetch hit limit — idempotency guard may miss older pairs',
            );
          }
          return tasks;
        },

        // Read-only: the sweep never records exclusions. Decline→exclude goes through the
        // contacts agent calling contact-dedup-exclude (#1625).
        listExclusionPairKeys: () => contactService.listDedupExclusionPairKeys(),
      };

      const result = await runDedup(contacts, identityMap, opts);

      // Drain pending contact.merged audit publishes before closing the pool, so every merge
      // has a persisted audit_log row (fixes the exit-race that dropped 1 of 14 on the first
      // prod run). allSettled never rejects; per-publish failures are counted in the .catch
      // above and folded into the exit code below.
      if (pendingMergePublishes.length > 0) {
        logger.info({ pending: pendingMergePublishes.length }, 'dedup-contacts: draining pending audit publishes');
        await Promise.allSettled(pendingMergePublishes);
      }

      // Summary report
      if (dryRun) {
        logger.info({
          wouldMergeCount: result.wouldMergeCount,
          wouldCreateTaskCount: result.wouldCreateTaskCount,
          skippedLowScoreCount: result.skippedLowScoreCount,
          skippedAboveMaxScoreCount: result.skippedAboveMaxScoreCount,
          suppressedTaskCount: result.suppressedTaskCount,
          skippedExcludedCount: result.skippedExcludedCount,
          principalSkippedCount: result.principalSkippedCount,
          // F5: Include errorCount in the dry-run summary — otherwise an operator
          // sees a clean "DRY-RUN complete" message while the process exits 1,
          // making it impossible to tell from the summary that something went wrong.
          errorCount: result.errorCount,
        }, 'dedup-contacts: DRY-RUN complete (no changes made)');
      } else {
        logger.info({
          mergedCount: result.mergedCount,
          taskCount: result.taskCount,
          skippedLowScoreCount: result.skippedLowScoreCount,
          skippedAboveMaxScoreCount: result.skippedAboveMaxScoreCount,
          suppressedTaskCount: result.suppressedTaskCount,
          skippedExcludedCount: result.skippedExcludedCount,
          principalSkippedCount: result.principalSkippedCount,
          auditPublishFailures,
          errorCount: result.errorCount,
        }, 'dedup-contacts: sweep complete');
      }

      await pool.end();
      // Non-zero exit on any sweep error OR any lost audit publish, so a partial audit
      // trail surfaces as a failed run rather than a silent gap.
      process.exit((result.errorCount > 0 || auditPublishFailures > 0) ? 1 : 0);
    } catch (err) {
      logger.error({ err }, 'dedup-contacts: fatal error');
      await pool.end();
      process.exit(1);
    }
  })();
}
