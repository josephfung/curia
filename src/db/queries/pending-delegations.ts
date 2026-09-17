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
  resolution: string | null;
  late_response_event_id: string | null;
  wake_task_event_id: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
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
  status: 'pending' | 'resolved';
  resolution: LateDelegationResolution | null;
  lateResponseEventId: string | null;
  wakeTaskEventId: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

const COLUMNS = `
  id, delegate_event_id, delegate_conversation_id, target_agent, delegate_task,
  origin_agent_id, origin_conversation_id, origin_channel_id, origin_sender_id,
  origin_task_event_id, originator, scheduler_job_id, review_task_id,
  status, resolution, late_response_event_id, wake_task_event_id,
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
    status: row.status as 'pending' | 'resolved',
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
}

/**
 * Atomically resolve an open handle and return it. Returns null when the handle does not
 * exist or another path already resolved it — which is the whole point: this conditional
 * UPDATE, not ordering luck, is what makes a late response act on the originator at most once.
 *
 * Callers pass the resolution up front because the classification is a pure function of the
 * late response; nothing between the claim and the side effect can change it.
 */
export async function claimPendingDelegation(
  pool: Pool,
  params: ClaimPendingDelegationParams,
): Promise<PendingDelegationRow | null> {
  const { rows } = await pool.query<DbPendingDelegationRow>(
    `UPDATE pending_delegations
        SET status = 'resolved',
            resolution = $2,
            late_response_event_id = COALESCE($3, late_response_event_id),
            wake_task_event_id = COALESCE($4, wake_task_event_id),
            resolved_at = now()
      WHERE delegate_event_id = $1 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [
      params.delegateEventId,
      params.resolution,
      params.lateResponseEventId ?? null,
      params.wakeTaskEventId ?? null,
    ],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
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

/** Open handles, oldest expiry first. The sweep walks these on every tick. */
export async function listOpenPendingDelegations(
  pool: Pool,
  limit = 100,
): Promise<PendingDelegationRow[]> {
  const { rows } = await pool.query<DbPendingDelegationRow>(
    `SELECT ${COLUMNS} FROM pending_delegations
      WHERE status = 'pending'
      ORDER BY expires_at ASC
      LIMIT $1`,
    [limit],
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
