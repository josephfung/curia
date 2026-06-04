import type { Pool } from 'pg';

// -- DB row shape (snake_case, mirrors Postgres column names) --

export interface DbTaskRow {
  id: string;
  agent_id: string;
  intent_anchor: string;
  status: string;
  progress: Record<string, unknown> | null;
  error_budget: Record<string, unknown> | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  // Columns added by migration 049
  title: string;
  description: string | null;
  owner: string;
  waiting_on_contact_id: string | null;
  waiting_on_text: string | null;
  parent_task_id: string | null;
  blocked_by_task_id: string | null;
  priority: number;
  due_at: string | null;
  source: string;
  source_agent_id: string | null;
  created_by: string;
  tags: string[];
}

// -- Public camelCase shape --

export interface TaskRow {
  id: string;
  agentId: string;
  intentAnchor: string;
  status: string;
  progress: Record<string, unknown>;
  errorBudget: Record<string, unknown>;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  title: string;
  description: string | null;
  owner: string;
  waitingOnContactId: string | null;
  waitingOnText: string | null;
  parentTaskId: string | null;
  blockedByTaskId: string | null;
  priority: number;
  dueAt: string | null;
  source: string;
  sourceAgentId: string | null;
  createdBy: string;
  tags: string[];
}

export function mapTaskRow(row: DbTaskRow): TaskRow {
  return {
    id: row.id,
    agentId: row.agent_id,
    intentAnchor: row.intent_anchor,
    status: row.status,
    progress: row.progress ?? {},
    errorBudget: row.error_budget ?? {},
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    description: row.description,
    owner: row.owner,
    waitingOnContactId: row.waiting_on_contact_id,
    waitingOnText: row.waiting_on_text,
    parentTaskId: row.parent_task_id,
    blockedByTaskId: row.blocked_by_task_id,
    priority: row.priority,
    dueAt: row.due_at,
    source: row.source,
    sourceAgentId: row.source_agent_id,
    createdBy: row.created_by,
    tags: row.tags,
  };
}

// -- Heartbeat candidate selection --

export interface HeartbeatCandidate {
  /** The task to wake. */
  id: string;
  /** The agent that will receive the wake — the task's source_agent_id, or the
   *  fallback agent when source_agent_id is null or not heartbeat-eligible. */
  agentId: string;
}

export interface SelectHeartbeatOptions {
  /** Heartbeat-eligible agent names (enable_task_management: true). */
  eligibleAgents: string[];
  idleThresholdHours: number;
  staleWaitThresholdHours: number;
  /** Global cap on candidates returned per call. */
  maxWakes: number;
  /** Agent that receives wakes for null / non-eligible owners. Default 'coordinator'. */
  fallbackAgentId?: string;
}

/** Select the heartbeat's wake candidates: one entry-point task per effective owner
 *  agent (idle-unblocked curia work, or orphaned waits past their threshold), globally
 *  capped, most-overdue first. Deterministic — no domain reasoning.
 *
 *  Two eligibility paths:
 *  1. Idle path: owner='curia', status in (open, in_progress), not blocked,
 *     no pending wake, updated_at older than idleThresholdHours.
 *  2. Stale-wait path: status in (waiting, blocked), blocker done/cancelled or
 *     no blocker, no pending wake, updated_at older than staleWaitThresholdHours.
 *
 *  Results are deduplicated to one task per effective agent (most-overdue first).
 */
export async function selectHeartbeatCandidates(
  pool: Pool,
  opts: SelectHeartbeatOptions,
): Promise<HeartbeatCandidate[]> {
  if (opts.eligibleAgents.length === 0) return [];
  const fallback = opts.fallbackAgentId ?? 'coordinator';
  // $1 = eligibleAgents array, $2 = idleThresholdHours, $3 = staleWaitThresholdHours,
  // $4 = fallbackAgentId, $5 = maxWakes
  // make_interval(hours => $N) binds $N as a numeric parameter — fully parameterized.
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT
         t.id,
         CASE WHEN t.source_agent_id = ANY($1::text[]) THEN t.source_agent_id ELSE $4 END AS effective_agent,
         t.updated_at
       FROM tasks t
       WHERE t.status IN ('open','in_progress','waiting','blocked')
         AND (t.blocked_by_task_id IS NULL OR EXISTS (
               SELECT 1 FROM tasks b
               WHERE b.id = t.blocked_by_task_id AND b.status IN ('done','cancelled')))
         AND NOT EXISTS (
               SELECT 1 FROM scheduled_jobs sj
               WHERE sj.task_id = t.id AND sj.status = 'pending')
         AND (
               (t.owner = 'curia' AND t.status IN ('open','in_progress')
                  AND t.updated_at < now() - make_interval(hours => $2))
            OR (t.status IN ('waiting','blocked')
                  AND t.updated_at < now() - make_interval(hours => $3))
             )
     ),
     per_agent AS (
       SELECT DISTINCT ON (effective_agent) id, effective_agent, updated_at
       FROM candidates
       ORDER BY effective_agent, updated_at ASC
     )
     SELECT id, effective_agent
     FROM per_agent
     ORDER BY updated_at ASC
     LIMIT $5`,
    [opts.eligibleAgents, opts.idleThresholdHours, opts.staleWaitThresholdHours, fallback, opts.maxWakes],
  );
  return rows.map((r) => {
    const row = r as unknown as { id: string; effective_agent: string };
    return { id: row.id, agentId: row.effective_agent };
  });
}

// Fetch a single task row by ID. Returns null if not found.
export async function getTaskById(pool: Pool, taskId: string): Promise<TaskRow | null> {
  const { rows } = await pool.query(
    `SELECT id, agent_id, intent_anchor, status, progress, error_budget, conversation_id,
            created_at, updated_at, title, description, owner, waiting_on_contact_id,
            waiting_on_text, parent_task_id, blocked_by_task_id, priority, due_at,
            source, source_agent_id, created_by, tags
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  const row = rows[0] as DbTaskRow | undefined;
  return row ? mapTaskRow(row) : null;
}
