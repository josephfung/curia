// pending-delegations.ts — durable handles for timed-out delegations (#1799).
//
// A delegate wait that times out abandons a specialist that is still running. One row per
// abandoned delegation, keyed by the delegate agent.task event id, is what lets a late
// agent.response be recognised minutes later — and after a process restart, which the
// handler's in-memory subscriber cannot survive.
//
// The claim (claimPendingDelegation) is the single gate every delivery path goes through.
// Exactly-once rests on the conditional UPDATE, not on timing: subscriber and sweep can race
// freely and only one of them gets the row back.
//
// The claim takes a LEASE ('claimed' + claimed_at + claim_token) rather than marking the handle
// finished. The
// side effects — annotating the review task, publishing the audit event — happen while the lease
// is held, and finalizePendingDelegation closes it afterwards. A crash in between leaves an
// expired lease that the sweep re-claims, so interrupted work is recoverable; marking the handle
// resolved up front would have recorded work that never happened.

import type { Pool } from 'pg';
import type { LateDelegationResolution } from '../../bus/events.js';

// -- DB row shape (snake_case, mirrors Postgres column names) --

interface DbPendingDelegationRow {
  id: string;
  delegate_event_id: string;
  delegate_conversation_id: string;
  target_agent: string;
  delegate_task: string;
  origin_agent_id: string;
  origin_conversation_id: string;
  origin_channel_id: string;
  origin_sender_id: string;
  origin_task_event_id: string | null;
  originator: Record<string, unknown> | null;
  scheduler_job_id: string | null;
  review_task_id: string | null;
  status: string;
  claimed_at: Date | null;
  claim_token: string | null;
  resolution: string | null;
  late_response_event_id: string | null;
  wake_task_event_id: string | null;
  // TIMESTAMPTZ columns. pg's default parser returns Date for these (the pool installs no
  // custom setTypeParser), so they are typed as Date rather than the string they are not.
  created_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
}

// -- Public camelCase shape --

export interface PendingDelegationRow {
  id: string;
  /** The delegate agent.task event id — the late response's parentEventId. */
  delegateEventId: string;
  delegateConversationId: string;
  targetAgent: string;
  /** Raw `task` input as the coordinator passed it; rebuilds delegationKey(). */
  delegateTask: string;
  originAgentId: string;
  originConversationId: string;
  originChannelId: string;
  originSenderId: string;
  originTaskEventId: string | null;
  originator: Record<string, unknown> | null;
  /** Scheduled job behind the originating turn, when there was one. */
  schedulerJobId: string | null;
  reviewTaskId: string | null;
  status: 'pending' | 'claimed' | 'resolved';
  /** When the current actor took its lease; null while pending. */
  claimedAt: Date | null;
  /** Proof of ownership for this lease — required to finalize or release it. */
  claimToken: string | null;
  resolution: LateDelegationResolution | null;
  lateResponseEventId: string | null;
  wakeTaskEventId: string | null;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
}

const COLUMNS = `
  id, delegate_event_id, delegate_conversation_id, target_agent, delegate_task,
  origin_agent_id, origin_conversation_id, origin_channel_id, origin_sender_id,
  origin_task_event_id, originator, scheduler_job_id, review_task_id,
  status, claimed_at, claim_token, resolution, late_response_event_id, wake_task_event_id,
  created_at, expires_at, resolved_at
`;

function mapRow(row: DbPendingDelegationRow): PendingDelegationRow {
  return {
    id: row.id,
    delegateEventId: row.delegate_event_id,
    delegateConversationId: row.delegate_conversation_id,
    targetAgent: row.target_agent,
    delegateTask: row.delegate_task,
    originAgentId: row.origin_agent_id,
    originConversationId: row.origin_conversation_id,
    originChannelId: row.origin_channel_id,
    originSenderId: row.origin_sender_id,
    originTaskEventId: row.origin_task_event_id,
    originator: row.originator,
    schedulerJobId: row.scheduler_job_id,
    reviewTaskId: row.review_task_id,
    // The CHECK constraint on the column keeps this cast honest.
    status: row.status as 'pending' | 'claimed' | 'resolved',
    claimedAt: row.claimed_at,
    claimToken: row.claim_token,
    resolution: row.resolution as LateDelegationResolution | null,
    lateResponseEventId: row.late_response_event_id,
    wakeTaskEventId: row.wake_task_event_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  };
}

export interface RecordPendingDelegationParams {
  delegateEventId: string;
  delegateConversationId: string;
  targetAgent: string;
  delegateTask: string;
  originAgentId: string;
  originConversationId: string;
  originChannelId: string;
  originSenderId: string;
  originTaskEventId?: string;
  originator?: Record<string, unknown>;
  schedulerJobId?: string;
  reviewTaskId?: string;
  expiresAt: Date;
}

/**
 * Open a handle for a timed-out delegation. Idempotent on delegate_event_id: a duplicate
 * delegation.timed_out (bus re-delivery, operator replay) returns the existing row rather than
 * a second handle — one delegation must never resolve twice.
 */
export async function recordPendingDelegation(
  pool: Pool,
  params: RecordPendingDelegationParams,
): Promise<{ row: PendingDelegationRow; created: boolean }> {
  const { rows } = await pool.query<DbPendingDelegationRow>(
    `INSERT INTO pending_delegations (
       delegate_event_id, delegate_conversation_id, target_agent, delegate_task,
       origin_agent_id, origin_conversation_id, origin_channel_id, origin_sender_id,
       origin_task_event_id, originator, scheduler_job_id, review_task_id, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
     ON CONFLICT (delegate_event_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      params.delegateEventId,
      params.delegateConversationId,
      params.targetAgent,
      params.delegateTask,
      params.originAgentId,
      params.originConversationId,
      params.originChannelId,
      params.originSenderId,
      params.originTaskEventId ?? null,
      params.originator ? JSON.stringify(params.originator) : null,
      params.schedulerJobId ?? null,
      params.reviewTaskId ?? null,
      params.expiresAt,
    ],
  );

  const inserted = rows[0];
  if (inserted) return { row: mapRow(inserted), created: true };

  // DO NOTHING swallowed the insert — the handle already exists. Read it back so callers
  // always get a row (and can see the resolution it may already carry).
  const existing = await getPendingDelegationByDelegateEventId(pool, params.delegateEventId);
  if (!existing) {
    // Only reachable if the conflicting row was deleted between the INSERT and this SELECT.
    throw new Error(
      `pending_delegations: insert conflicted on ${params.delegateEventId} but the row is gone`,
    );
  }
  return { row: existing, created: false };
}

/** An unresolved timed-out delegation still running for one specialist in one conversation (#1858). */
export interface InFlightDelegation {
  /** The delegate agent.task event id of the run that is still open. */
  delegateEventId: string;
  /**
   * When the handle was opened. That is after the delegate wait expired, so age
   * measured from here is not how long the specialist has been running.
   */
  createdAt: Date;
}

/**
 * Read-only lookup the delegate skill consults before starting another specialist run.
 * Implementations query `pending_delegations`; tests supply a fake.
 */
export interface OpenDelegationLookup {
  findInFlight(targetAgent: string, originConversationId: string): Promise<InFlightDelegation | null>;
}

/**
 * The oldest unresolved handle for this specialist in this originating conversation, or null.
 *
 * Pending is the unresolved state. Migration 086's CHECK already forces
 * `resolution IS NULL` whenever `status = 'pending'`, so this query does not
 * repeat that predicate. A claimed or resolved handle means that run has
 * finished. Task text is deliberately not a predicate — the coordinator
 * rewords it between attempts (#1858). An expired-but-still-pending row still
 * matches: the specialist may yet complete and send, and the sweep is what
 * closes it.
 */
export async function findInFlightPendingDelegation(
  pool: Pool,
  params: { targetAgent: string; originConversationId: string },
): Promise<InFlightDelegation | null> {
  const { rows } = await pool.query<{ delegate_event_id: string; created_at: Date | string }>(
    `SELECT delegate_event_id, created_at
       FROM pending_delegations
      WHERE target_agent = $1
        AND origin_conversation_id = $2
        AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1`,
    [params.targetAgent, params.originConversationId],
  );
  const row = rows[0];
  if (!row) return null;
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(
      `pending_delegations.created_at is not a valid timestamp for ${row.delegate_event_id}`,
    );
  }
  return { delegateEventId: row.delegate_event_id, createdAt };
}

/** Read a handle by its correlation key, whatever its status. */
export async function getPendingDelegationByDelegateEventId(
  pool: Pool,
  delegateEventId: string,
): Promise<PendingDelegationRow | null> {
  const { rows } = await pool.query<DbPendingDelegationRow>(
    `SELECT ${COLUMNS} FROM pending_delegations WHERE delegate_event_id = $1`,
    [delegateEventId],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export interface ClaimPendingDelegationParams {
  delegateEventId: string;
  resolution: LateDelegationResolution;
  lateResponseEventId?: string;
  wakeTaskEventId?: string;
  /** How long the lease is good for. A claim older than this is up for grabs again. */
  leaseSeconds: number;
}

/**
 * Take the lease on a handle and return it. Returns null when the handle does not exist, is
 * already resolved, or is held by a live lease — which is the point: this conditional UPDATE,
 * not ordering luck, is what keeps a late response from being acted on twice.
 *
 * A lease older than `leaseSeconds` is re-claimable: its holder crashed or died mid-flight, so
 * the work still needs doing. Callers pass the resolution up front because the classification is
 * a pure function of the late response — a retry reaches the same verdict.
 */
export async function claimPendingDelegation(
  pool: Pool,
  params: ClaimPendingDelegationParams,
): Promise<PendingDelegationRow | null> {
  const { rows } = await pool.query<DbPendingDelegationRow>(
    `UPDATE pending_delegations
        SET status = 'claimed',
            claimed_at = now(),
            claim_token = gen_random_uuid(),
            resolution = $2,
            late_response_event_id = COALESCE($3, late_response_event_id),
            wake_task_event_id = COALESCE($4, wake_task_event_id)
      WHERE delegate_event_id = $1
        AND (
          status = 'pending'
          OR (status = 'claimed' AND claimed_at < now() - make_interval(secs => $5::int))
        )
      RETURNING ${COLUMNS}`,
    [
      params.delegateEventId,
      params.resolution,
      params.lateResponseEventId ?? null,
      params.wakeTaskEventId ?? null,
      params.leaseSeconds,
    ],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Close out a claimed handle once its side effects have landed. Returns null when the caller no
 * longer owns the lease.
 *
 * The `claim_token` match is what makes that check meaningful. `status = 'claimed'` alone only
 * proves SOMEONE holds a lease: an actor that stalled past its expiry, and whose handle was
 * re-claimed by another, would otherwise mark the new claimant's in-flight work resolved and
 * strand it half-done — reintroducing the loss the lease exists to prevent.
 */
export async function finalizePendingDelegation(
  pool: Pool,
  delegateEventId: string,
  claimToken: string,
): Promise<PendingDelegationRow | null> {
  const { rows } = await pool.query<DbPendingDelegationRow>(
    `UPDATE pending_delegations
        SET status = 'resolved', resolved_at = now()
      WHERE delegate_event_id = $1 AND status = 'claimed' AND claim_token = $2
      RETURNING ${COLUMNS}`,
    [delegateEventId, claimToken],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Hand a claimed handle straight back for retry after a transient failure, instead of making the
 * next attempt wait out the whole lease. Clears the verdict too: the retry re-reads the review
 * task and re-classifies, which is what makes a human closing that task in the meantime win.
 *
 * Token-guarded for the same reason as finalize — a stale actor must not be able to yank a lease
 * another claimant is actively working under, which would let two actors run side effects at once.
 */
export async function releasePendingDelegationClaim(
  pool: Pool,
  delegateEventId: string,
  claimToken: string,
): Promise<void> {
  await pool.query(
    `UPDATE pending_delegations
        SET status = 'pending', claimed_at = NULL, claim_token = NULL, resolution = NULL
      WHERE delegate_event_id = $1 AND status = 'claimed' AND claim_token = $2`,
    [delegateEventId, claimToken],
  );
}

/** Record the wake event id on an already-claimed handle (Phase 2 publishes after claiming). */
export async function setPendingDelegationWakeEventId(
  pool: Pool,
  delegateEventId: string,
  wakeTaskEventId: string,
): Promise<void> {
  await pool.query(
    `UPDATE pending_delegations SET wake_task_event_id = $2 WHERE delegate_event_id = $1`,
    [delegateEventId, wakeTaskEventId],
  );
}

/**
 * Unfinished handles, oldest expiry first — what the sweep walks on every tick. Includes handles
 * whose lease expired mid-flight: that is the crash-recovery path, and skipping them would leave
 * the very work this table exists to protect half-done.
 */
export async function listOpenPendingDelegations(
  pool: Pool,
  leaseSeconds: number,
  limit = 100,
): Promise<PendingDelegationRow[]> {
  const { rows } = await pool.query<DbPendingDelegationRow>(
    `SELECT ${COLUMNS} FROM pending_delegations
      WHERE status = 'pending'
         OR (status = 'claimed' AND claimed_at < now() - make_interval(secs => $1::int))
      ORDER BY expires_at ASC
      LIMIT $2`,
    [leaseSeconds, limit],
  );
  return rows.map(mapRow);
}

/**
 * The late agent.response for a handle, read from audit_log rather than the bus.
 *
 * This is the recovery path, and it covers two gaps, not one. The bus is in-process, so a
 * response published while we were down reached no matcher — and so did one that arrived in the
 * narrow window between the delegate wait timing out and the handle being written (the escalation
 * task-create sits between them). Either way the audit logger's write-ahead hook persisted the
 * event, so audit_log is the durable record. parent_event_id is indexed by migration 087.
 *
 * Returns the EARLIEST matching response: a specialist may emit a pause followed by a final
 * result, and replaying them in order keeps the sweep's classification identical to what the
 * live subscriber would have decided.
 */
export async function findLateResponseInAuditLog(
  pool: Pool,
  delegateEventId: string,
): Promise<{ eventId: string; payload: Record<string, unknown>; timestamp: string } | null> {
  const { rows } = await pool.query<{ id: string; payload: Record<string, unknown>; timestamp: string }>(
    `SELECT id, payload, timestamp FROM audit_log
      WHERE parent_event_id = $1 AND event_type = 'agent.response'
      ORDER BY seq ASC
      LIMIT 1`,
    [delegateEventId],
  );
  const row = rows[0];
  return row ? { eventId: row.id, payload: row.payload, timestamp: row.timestamp } : null;
}
