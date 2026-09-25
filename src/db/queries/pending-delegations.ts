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
import type { TaskOriginator } from '../../contacts/types.js';

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
  status: 'running' | 'pending' | 'claimed' | 'resolved';
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
    status: row.status as PendingDelegationRow['status'],
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
 *
 * A dispatch-time `running` claim for this same event (#1893) is promoted in place: status
 * becomes `pending` and `expires_at` becomes the late-delivery TTL. That is the #1858 handle,
 * not a second row.
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
     ON CONFLICT (delegate_event_id) DO UPDATE
       SET status = 'pending',
           expires_at = EXCLUDED.expires_at,
           review_task_id = COALESCE(EXCLUDED.review_task_id, pending_delegations.review_task_id),
           delegate_task = EXCLUDED.delegate_task,
           originator = COALESCE(EXCLUDED.originator, pending_delegations.originator),
           scheduler_job_id = COALESCE(EXCLUDED.scheduler_job_id, pending_delegations.scheduler_job_id)
       WHERE pending_delegations.status = 'running'
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
   * When the row was written. A `running` claim is written at dispatch, so this is
   * the start of the specialist run. A promoted `pending` handle keeps that same
   * `created_at` — age from it is not how long the handle has left.
   */
  createdAt: Date;
  /**
   * `running` is a dispatch claim. `pending` is the post-timeout handle, which
   * outlives the delegate wait. Absent only on the fail-closed synthetic hit
   * used when the blocking row vanished between the insert and this read.
   */
  status?: 'running' | 'pending';
  /** When this row stops being eligible. The sweep may close it one interval later. */
  expiresAt?: Date;
}

/**
 * Read-only lookup the delegate skill consults before starting another specialist run.
 * Implementations query `pending_delegations`; tests supply a fake.
 */
export interface OpenDelegationLookup {
  findInFlight(targetAgent: string, originConversationId: string): Promise<InFlightDelegation | null>;
  /**
   * Atomic dispatch-time claim (#1893). Absent when a test only stubs the
   * post-timeout lookup. A conflict is an in-flight refusal — the insert is the check.
   */
  acquireRunning?(params: AcquireRunningDelegationParams): Promise<AcquireRunningResult>;
  /** Delete a `running` claim. A no-op once the row has been promoted to `pending`. */
  releaseRunning?(delegateEventId: string): Promise<void>;
}

/**
 * The oldest unresolved handle for this specialist in this originating conversation, or null.
 *
 * `running` is a dispatch claim that has not returned yet. `pending` is the
 * post-timeout handle. Migration 086's CHECK forces `resolution IS NULL` for both,
 * so this query does not repeat that predicate. A claimed or resolved handle means
 * that run has finished. Task text is deliberately not a predicate — the coordinator
 * rewords it between attempts (#1858). An expired-but-still-open row still matches:
 * the specialist may yet complete and send, and the sweep is what closes it.
 */
export async function findInFlightPendingDelegation(
  pool: Pool,
  params: { targetAgent: string; originConversationId: string },
): Promise<InFlightDelegation | null> {
  const { rows } = await pool.query<{
    delegate_event_id: string;
    created_at: Date | string;
    expires_at: Date | string;
    status: string;
  }>(
    `SELECT delegate_event_id, created_at, expires_at, status
       FROM pending_delegations
      WHERE target_agent = $1
        AND origin_conversation_id = $2
        AND status IN ('running', 'pending')
      ORDER BY created_at ASC
      LIMIT 1`,
    [params.targetAgent, params.originConversationId],
  );
  const row = rows[0];
  if (!row) return null;
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    throw new Error(
      `pending_delegations timestamps are not valid for ${row.delegate_event_id}`,
    );
  }
  if (row.status !== 'running' && row.status !== 'pending') {
    throw new Error(
      `pending_delegations.status is not in flight for ${row.delegate_event_id}`,
    );
  }
  return { delegateEventId: row.delegate_event_id, createdAt, expiresAt, status: row.status };
}

/**
 * How long a crashed process may keep a dispatch claim after the wait itself.
 * The claim's expires_at is the wait plus this grace, so the sweep does not
 * abandon a row in the gap between the wait ending and the timeout promotion,
 * and a dead process still frees the specialist in about the wait — not the
 * late-delivery hour.
 */
export const RUNNING_CLAIM_GRACE_MS = 60_000;

export function runningClaimExpiresAt(now: Date, waitTimeoutMs: number): Date {
  return new Date(now.getTime() + waitTimeoutMs + RUNNING_CLAIM_GRACE_MS);
}

export interface AcquireRunningDelegationParams {
  delegateEventId: string;
  delegateConversationId: string;
  targetAgent: string;
  delegateTask: string;
  originAgentId: string;
  originConversationId: string;
  originChannelId: string;
  originSenderId: string;
  originTaskEventId?: string;
  schedulerJobId?: string;
  /** Validated lineage. A crashed claim is recovered from this row, so a null here
   *  wakes the follow-up with no autonomy standing. */
  originator?: TaskOriginator;
  expiresAt: Date;
}

export type AcquireRunningResult =
  | { acquired: true; claim: { delegateEventId: string } }
  | { acquired: false; inFlight: InFlightDelegation };

/**
 * Claim the specialist for this originating conversation. One statement: a pending
 * or running row blocks the insert, and the partial unique index breaks the race
 * where two turns both saw the slot empty.
 */
export async function acquireRunningDelegation(
  pool: Pool,
  params: AcquireRunningDelegationParams,
): Promise<AcquireRunningResult> {
  const { rows } = await pool.query<{ delegate_event_id: string }>(
    `INSERT INTO pending_delegations (
       delegate_event_id, delegate_conversation_id, target_agent, delegate_task,
       origin_agent_id, origin_conversation_id, origin_channel_id, origin_sender_id,
       origin_task_event_id, scheduler_job_id, originator, expires_at, status
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'running'
      WHERE NOT EXISTS (
        SELECT 1 FROM pending_delegations
         WHERE target_agent = $3
           AND origin_conversation_id = $6
           AND status IN ('running', 'pending')
      )
     ON CONFLICT (target_agent, origin_conversation_id) WHERE status = 'running'
     DO NOTHING
     RETURNING delegate_event_id`,
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
      params.schedulerJobId ?? null,
      params.originator ? JSON.stringify(params.originator) : null,
      params.expiresAt,
    ],
  );
  if (rows[0]) return { acquired: true, claim: { delegateEventId: rows[0].delegate_event_id } };

  const inFlight = await findInFlightPendingDelegation(pool, {
    targetAgent: params.targetAgent,
    originConversationId: params.originConversationId,
  });
  if (inFlight) return { acquired: false, inFlight };
  // The blocking row disappeared between the insert and this read. Fail closed:
  // starting the run is how a second message reaches the principal.
  return {
    acquired: false,
    inFlight: { delegateEventId: params.delegateEventId, createdAt: new Date() },
  };
}

/**
 * Drop a dispatch claim. Promoting the row to `pending` makes the delete a no-op.
 *
 * A delete that throws leaves the row `running`. The sweep would then find the
 * specialist's answer in audit_log and deliver it again, on top of the result
 * this caller already returned. The fallback marks that row resolved as
 * `delivered` so the sweep skips it. If the mark also fails, the error propagates
 * and the row stays running until `expires_at`.
 */
export async function releaseRunningDelegation(
  pool: Pool,
  delegateEventId: string,
): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM pending_delegations
        WHERE delegate_event_id = $1 AND status = 'running'`,
      [delegateEventId],
    );
    return;
  } catch (deleteErr) {
    try {
      const settled = await pool.query(
        `UPDATE pending_delegations
            SET status = 'resolved',
                resolution = 'delivered',
                claimed_at = now(),
                claim_token = gen_random_uuid(),
                resolved_at = now()
          WHERE delegate_event_id = $1 AND status = 'running'`,
        [delegateEventId],
      );
      if ((settled.rowCount ?? 0) > 0) return;
    } catch (settleErr) {
      throw new Error(
        `release running delegation ${delegateEventId} failed, and marking it delivered failed`,
        { cause: settleErr },
      );
    }
    throw deleteErr;
  }
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
          OR status = 'running'
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

/**
 * Push a live lease forward without minting a new token.
 *
 * The wake's `publish()` awaits the woken turn, which outlives the lease (#1861). Refreshing
 * `claimed_at` under the same token keeps that turn's holder the owner, so the sweep does not
 * re-claim the row and record the outcome a second time. Returns false when this token no longer
 * owns the row — a stale holder must not extend a lease someone else now holds.
 */
export async function renewPendingDelegationClaim(
  pool: Pool,
  delegateEventId: string,
  claimToken: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_delegations
        SET claimed_at = now()
      WHERE delegate_event_id = $1
        AND status = 'claimed'
        AND claim_token = $2
      RETURNING delegate_event_id`,
    [delegateEventId, claimToken],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * Whether this handle's outcome is already in the audit log.
 *
 * `target_type` is part of the predicate so the lookup uses `idx_audit_target`. A re-claim after
 * the event landed — the holder crashed between the publish and finalize — must close the lease
 * without annotating the review task or emitting the event again (#1861).
 */
export async function hasDelegationLateResolvedAudit(
  pool: Pool,
  delegateEventId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM audit_log
      WHERE event_type = 'delegation.late_resolved'
        AND target_type = 'delegation'
        AND target_id = $1
      LIMIT 1`,
    [delegateEventId],
  );
  return rows.length > 0;
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
 * whose lease expired mid-flight, and dispatch claims whose wait-derived expiry has passed
 * (the process died while the specialist was running). A live claim is not listed: its
 * handler still owns it.
 */
export async function listOpenPendingDelegations(
  pool: Pool,
  leaseSeconds: number,
  limit = 100,
): Promise<PendingDelegationRow[]> {
  const { rows } = await pool.query<DbPendingDelegationRow>(
    `SELECT ${COLUMNS} FROM pending_delegations
      WHERE status = 'pending'
         OR (status = 'running' AND expires_at <= now())
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
