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
