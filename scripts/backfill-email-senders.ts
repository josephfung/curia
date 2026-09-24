// scripts/backfill-email-senders.ts
//
// One-off: recover email 1:1 sender attribution for working_memory rows written
// before migration 090 (#1887, ADR-042).
//
// Why a script and not a migration: only a database that predates 090 holds
// unstamped rows, and every new install stamps on write. Boot-time code modelled
// on direct-sender-backfill.ts would run to completion once, on one database,
// then re-run a no-op query on every deployment forever.
//
// How the sender is recovered: working_memory never stored the per-turn From
// address, but audit_log did and nothing prunes it. Every inbound email left an
// `inbound.message` row carrying the conversation id, the From address, and the
// message content. A turn is matched to the audit row in the same conversation
// whose payload content appears verbatim inside it — content anchoring, not
// timestamp proximity, which was measurably worse and can swap the authors of
// two messages that arrived close together in one thread.
//
// What it refuses to do: if a turn matches more than one distinct sender, or the
// recovered address maps to more than one contact, the row is left null. A null
// sender keeps its conversation shared, which is the behaviour without this
// script at all, so an incomplete backfill is never a wrong one.
//
// Run: pnpm run backfill:email-senders            (dry run, writes nothing)
//      pnpm run backfill:email-senders -- --apply (writes)
// Safety: idempotent — only ever writes to rows whose sender is still NULL.

import pg from 'pg';
import pino from 'pino';

const logger = pino({ name: 'backfill-email-senders' });

const { Pool } = pg;

/** Rows written per UPDATE, so one statement is not a table rewrite. */
const APPLY_BATCH_SIZE = 200;

/**
 * One unattributed email user turn, with everything needed to decide whether it
 * can be attributed. Counts come back as strings from pg (bigint) and are
 * normalized before this shape is built.
 */
export interface ResolvedEmailTurn {
  id: string;
  conversationId: string;
  /** Distinct senders whose audit content was found inside this turn. 1 is the only usable value. */
  senderCount: number;
  senderEmail: string | null;
  /** Contacts claiming that address. 1 is the only usable value. */
  contactMatches: number;
  contactId: string | null;
}

export type UnresolvedReason =
  | 'no-audit-match'
  | 'ambiguous-sender'
  | 'sender-not-a-contact'
  | 'ambiguous-contact';

export interface ConversationOutcome {
  conversationId: string;
  rows: number;
  stamped: number;
  /**
   * `complete` means every unattributed row in the thread resolved, so the
   * shared check can now see the thread truthfully. `partial` means at least one
   * row stayed null, which leaves the thread shared exactly as before — the
   * stamps applied to it buy nothing on their own.
   */
  status: 'complete' | 'partial' | 'none';
  unresolved: Array<{ id: string; reason: UnresolvedReason }>;
}

export interface BackfillSummary {
  rows: number;
  rowsStampable: number;
  threads: number;
  threadsComplete: number;
  threadsPartial: number;
  threadsNone: number;
  /** Complete threads with more than one sender: correctly shared, not broken. */
  threadsMultiContact: number;
  contactsAffected: number;
}

export interface BackfillPlan {
  updates: Array<{ id: string; contactId: string }>;
  conversations: ConversationOutcome[];
  summary: BackfillSummary;
}

/**
 * Resolve every unattributed email user turn to the sender recorded in the audit
 * log. Returns one row per turn; the decision of what to do with it is the
 * planner's, so that logic stays testable without a database.
 */
export const RESOLVE_EMAIL_SENDERS_SQL = `
WITH target AS (
  SELECT id, conversation_id, content
  FROM working_memory
  WHERE role = 'user'
    AND conversation_id LIKE 'email:%'
    AND sender_contact_id IS NULL
),
matched AS (
  SELECT
    t.id,
    t.conversation_id,
    count(DISTINCT lower(coalesce(a.initiator_id, a.payload->>'senderId'))) AS sender_count,
    min(lower(coalesce(a.initiator_id, a.payload->>'senderId')))            AS sender_email
  FROM target t
  LEFT JOIN audit_log a
    ON a.event_type = 'inbound.message'
   -- target_id is the structured column added in #1383; older rows only have the
   -- JSONB payload, so both are consulted.
   AND coalesce(a.target_id, a.payload->>'conversationId') = t.conversation_id
   AND length(coalesce(a.payload->>'content', '')) > 0
   AND position(a.payload->>'content' in t.content) > 0
  GROUP BY t.id, t.conversation_id
)
SELECT
  m.id,
  m.conversation_id,
  m.sender_count,
  m.sender_email,
  c.contact_matches,
  c.contact_id
FROM matched m
LEFT JOIN LATERAL (
  SELECT count(DISTINCT cci.contact_id) AS contact_matches,
         min(cci.contact_id::text)      AS contact_id
  FROM contact_channel_identities cci
  WHERE cci.channel = 'email'
    AND lower(cci.channel_identifier) = m.sender_email
) c ON true
ORDER BY m.conversation_id, m.id
`;

const APPLY_SQL = `UPDATE working_memory
   SET sender_contact_id = u.contact_id::uuid,
       channel_id = coalesce(working_memory.channel_id, 'email')
   FROM unnest($1::uuid[], $2::uuid[]) AS u(id, contact_id)
   WHERE working_memory.id = u.id
     AND working_memory.sender_contact_id IS NULL`;

function unresolvedReason(turn: ResolvedEmailTurn): UnresolvedReason | null {
  if (turn.senderCount === 0 || turn.senderEmail === null) return 'no-audit-match';
  if (turn.senderCount > 1) return 'ambiguous-sender';
  if (turn.contactMatches === 0) return 'sender-not-a-contact';
  if (turn.contactMatches > 1) return 'ambiguous-contact';
  if (turn.contactId === null) return 'sender-not-a-contact';
  return null;
}

/**
 * Decide, per conversation, what can be stamped.
 *
 * Reporting is per conversation rather than per row on purpose: one unattributed
 * user turn anywhere in a thread marks the whole thread shared, so a thread that
 * ends up `partial` gained nothing even though rows in it were written.
 */
export function planEmailSenderBackfill(turns: readonly ResolvedEmailTurn[]): BackfillPlan {
  const updates: Array<{ id: string; contactId: string }> = [];
  const byConversation = new Map<string, ConversationOutcome>();
  const contactsAffected = new Set<string>();
  const contactsPerConversation = new Map<string, Set<string>>();

  for (const turn of turns) {
    let outcome = byConversation.get(turn.conversationId);
    if (!outcome) {
      outcome = { conversationId: turn.conversationId, rows: 0, stamped: 0, status: 'none', unresolved: [] };
      byConversation.set(turn.conversationId, outcome);
      contactsPerConversation.set(turn.conversationId, new Set());
    }
    outcome.rows += 1;

    const reason = unresolvedReason(turn);
    if (reason !== null || turn.contactId === null) {
      outcome.unresolved.push({ id: turn.id, reason: reason ?? 'sender-not-a-contact' });
      continue;
    }

    updates.push({ id: turn.id, contactId: turn.contactId });
    outcome.stamped += 1;
    contactsAffected.add(turn.contactId);
    contactsPerConversation.get(turn.conversationId)?.add(turn.contactId);
  }

  let threadsComplete = 0;
  let threadsPartial = 0;
  let threadsNone = 0;
  let threadsMultiContact = 0;
  for (const outcome of byConversation.values()) {
    if (outcome.stamped === outcome.rows) {
      outcome.status = 'complete';
      threadsComplete += 1;
      if ((contactsPerConversation.get(outcome.conversationId)?.size ?? 0) > 1) threadsMultiContact += 1;
    } else if (outcome.stamped > 0) {
      outcome.status = 'partial';
      threadsPartial += 1;
    } else {
      outcome.status = 'none';
      threadsNone += 1;
    }
  }

  return {
    updates,
    conversations: [...byConversation.values()],
    summary: {
      rows: turns.length,
      rowsStampable: updates.length,
      threads: byConversation.size,
      threadsComplete,
      threadsPartial,
      threadsNone,
      threadsMultiContact,
      contactsAffected: contactsAffected.size,
    },
  };
}

interface ResolvedRowShape {
  id: string;
  conversation_id: string;
  sender_count: string | number;
  sender_email: string | null;
  contact_matches: string | number | null;
  contact_id: string | null;
}

function toResolvedTurn(row: ResolvedRowShape): ResolvedEmailTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderCount: Number(row.sender_count),
    senderEmail: row.sender_email,
    contactMatches: Number(row.contact_matches ?? 0),
    contactId: row.contact_id,
  };
}

export interface BackfillReport extends BackfillPlan {
  /** Rows actually written. Zero on a dry run. */
  applied: number;
  dryRun: boolean;
}

export async function runEmailSenderBackfill(
  pool: pg.Pool,
  options: { dryRun: boolean; batchSize?: number },
): Promise<BackfillReport> {
  const { rows } = await pool.query<ResolvedRowShape>(RESOLVE_EMAIL_SENDERS_SQL);
  const plan = planEmailSenderBackfill(rows.map(toResolvedTurn));

  // Every unresolved row is named, not just counted. The whole reason #1887
  // existed is that this class of fault produced correct-looking output with
  // nothing to grep for.
  for (const conversation of plan.conversations) {
    if (conversation.status === 'complete') continue;
    logger.info(
      {
        conversationId: conversation.conversationId,
        status: conversation.status,
        rows: conversation.rows,
        stamped: conversation.stamped,
        unresolved: conversation.unresolved,
      },
      'backfill-email-senders: conversation not fully attributable',
    );
  }

  if (options.dryRun) {
    logger.info({ ...plan.summary, dryRun: true }, 'backfill-email-senders: dry run, nothing written');
    return { ...plan, applied: 0, dryRun: true };
  }

  const batchSize = options.batchSize ?? APPLY_BATCH_SIZE;
  let applied = 0;
  for (let offset = 0; offset < plan.updates.length; offset += batchSize) {
    const batch = plan.updates.slice(offset, offset + batchSize);
    const result = await pool.query(
      APPLY_SQL,
      [batch.map(u => u.id), batch.map(u => u.contactId)],
    );
    applied += result.rowCount ?? 0;
  }

  logger.info({ ...plan.summary, applied, dryRun: false }, 'backfill-email-senders: done');
  return { ...plan, applied, dryRun: false };
}

// CLI entry point — only runs when executed directly.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    logger.error('backfill-email-senders: DATABASE_URL is not set');
    process.exit(1);
  }
  // Dry run is the default: writing requires saying so.
  const dryRun = !process.argv.includes('--apply');
  const pool = new Pool({ connectionString: databaseUrl });
  runEmailSenderBackfill(pool, { dryRun })
    .then(async (report) => {
      await pool.end();
      if (report.dryRun) {
        logger.info('backfill-email-senders: re-run with --apply to write these stamps');
      }
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'backfill-email-senders: fatal error');
      await pool.end();
      process.exit(1);
    });
}
