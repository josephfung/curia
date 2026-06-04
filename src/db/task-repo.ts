// task-repo.ts — database operations for the tasks table and associated wake-up jobs.
//
// Skills cannot access the pool directly, so all task CRUD goes through this repo.
// The TaskRepo also publishes task.created / task.updated / task.completed bus events
// (same pattern as SchedulerService publishing schedule.created).

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import {
  createTaskCreated,
  createTaskUpdated,
  createTaskCompleted,
} from '../bus/events.js';
import type { DbTaskRow, TaskRow } from './queries/tasks.js';
import { mapTaskRow } from './queries/tasks.js';

// All SELECT / RETURNING clauses use this column list. Centralised so a schema
// change only needs updating in one place.
const TASK_COLUMNS = `
  id, agent_id, intent_anchor, title, description, status, progress, error_budget,
  conversation_id, created_at, updated_at, owner, waiting_on_contact_id,
  waiting_on_text, parent_task_id, blocked_by_task_id, priority, due_at,
  source, source_agent_id, created_by, tags
`;

// -- Public types --

export interface CreateTaskParams {
  agentId: string;
  title: string;
  description?: string;
  owner?: 'curia' | 'ceo' | 'external';
  parentTaskId?: string;
  blockedByTaskId?: string;
  priority?: number;
  dueAt?: Date;
  tags?: string[];
  waitingOnContactId?: string;
  waitingOnText?: string;
  intentAnchor?: string;
  source?: 'ceo' | 'agent' | 'scheduler' | 'coordinator';
  sourceAgentId?: string;
  createdBy?: string;
  /** When set, creates a linked one-shot scheduled_jobs row in the same transaction. */
  wakeAt?: Date;
}

export interface UpdateTaskParams {
  status?: string;
  priority?: number;
  owner?: string;
  dueAt?: Date | null;
  tags?: string[];
  progressNote?: string;
  blockedByTaskId?: string | null;
  /** When provided, cancels existing pending wake-up jobs and creates a new one-shot. */
  wakeAt?: Date;
}

export interface ListTasksFilters {
  statuses?: string[];
  owner?: string;
  tag?: string;
  parentTaskId?: string;
  dueBefore?: Date;
  limit?: number;
}

// Extended row returned by list — includes the next pending wake-up time if any.
export interface TaskListRow extends TaskRow {
  nextWakeAt: string | null;
}

// Terminal statuses: no transitions out of these.
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

export class TaskRepo {
  constructor(
    private readonly pool: Pool,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly timezone: string = 'UTC',
  ) {}

  /**
   * Insert a new task row. When `wakeAt` is provided, the insert and the
   * scheduled_jobs insert are wrapped in a single CTE for atomicity.
   */
  async createTask(params: CreateTaskParams): Promise<TaskRow> {
    const {
      agentId,
      title,
      description,
      owner = 'curia',
      parentTaskId,
      blockedByTaskId,
      priority = 50,
      dueAt,
      tags = [],
      waitingOnContactId,
      waitingOnText,
      intentAnchor,
      source = 'agent',
      sourceAgentId,
      createdBy,
      wakeAt,
    } = params;

    const resolvedCreatedBy = createdBy ?? agentId;
    const resolvedIntentAnchor = intentAnchor ?? title;

    // Always insert with 'open' status for skill-created tasks.
    const taskInsertSql = `
      INSERT INTO tasks (
        agent_id, title, intent_anchor, description, status, progress, error_budget,
        owner, parent_task_id, blocked_by_task_id, priority, due_at, tags,
        waiting_on_contact_id, waiting_on_text, source, source_agent_id, created_by
      )
      VALUES ($1, $2, $3, $4, 'open', '{"notes":[]}'::jsonb, '{}'::jsonb,
              $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING ${TASK_COLUMNS}
    `;
    const taskParams: unknown[] = [
      agentId,
      title,
      resolvedIntentAnchor,
      description ?? null,
      owner,
      parentTaskId ?? null,
      blockedByTaskId ?? null,
      priority,
      dueAt ?? null,
      tags,
      waitingOnContactId ?? null,
      waitingOnText ?? null,
      source,
      sourceAgentId ?? null,
      resolvedCreatedBy,
    ];

    let row: DbTaskRow;

    if (wakeAt) {
      // Atomic CTE: insert task + insert linked one-shot wake-up job in one round-trip.
      // The task_payload carries minimal context; the dispatcher (issue 4) loads the full
      // task from tasks.id via the scheduled_jobs.task_id FK.
      const cteSql = `
        WITH new_task AS (
          INSERT INTO tasks (
            agent_id, title, intent_anchor, description, status, progress, error_budget,
            owner, parent_task_id, blocked_by_task_id, priority, due_at, tags,
            waiting_on_contact_id, waiting_on_text, source, source_agent_id, created_by
          )
          VALUES ($1, $2, $3, $4, 'open', '{"notes":[]}'::jsonb, '{}'::jsonb,
                  $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING ${TASK_COLUMNS}
        ),
        _wake_job AS (
          INSERT INTO scheduled_jobs (agent_id, run_at, task_payload, status, next_run_at, created_by, timezone, task_id)
          SELECT $16, $17, '{"type":"task-wake"}'::jsonb, 'pending', $17, $18, $19, new_task.id
          FROM new_task
        )
        SELECT * FROM new_task
      `;
      const { rows } = await this.pool.query(cteSql, [
        ...taskParams,
        agentId,           // $16 — scheduled_jobs.agent_id
        wakeAt,            // $17 — run_at / next_run_at
        resolvedCreatedBy, // $18 — created_by
        this.timezone,     // $19 — timezone
      ]);
      row = rows[0] as DbTaskRow | undefined
        ?? (() => { throw new Error('task-repo: createTask CTE returned no row'); })();
    } else {
      const { rows } = await this.pool.query(taskInsertSql, taskParams);
      row = rows[0] as DbTaskRow | undefined
        ?? (() => { throw new Error('task-repo: createTask INSERT returned no row'); })();
    }

    const task = mapTaskRow(row);

    // The DB write has committed. A bus-publish failure is an observability gap,
    // not a data-integrity failure — log it but do not surface it as a task-creation
    // failure (which would cause the caller to retry and create a duplicate row).
    try {
      await this.bus.publish('execution', createTaskCreated({
        taskId: task.id,
        title: task.title,
        owner: task.owner,
        source: task.source,
        sourceAgentId: task.sourceAgentId,
        agentId: task.agentId,
      }));
    } catch (busErr) {
      this.logger.error({ busErr, taskId: task.id }, 'task-repo: bus publish failed after createTask');
    }

    this.logger.info({ taskId: task.id, title: task.title }, 'task-repo: created task');
    return task;
  }

  /**
   * Fetch a single task by ID. Returns null if not found.
   */
  async getTask(taskId: string): Promise<TaskRow | null> {
    const { rows } = await this.pool.query(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`,
      [taskId],
    );
    const row = rows[0] as DbTaskRow | undefined;
    return row ? mapTaskRow(row) : null;
  }

  /**
   * List tasks with optional filters. Returns rows ordered by priority DESC, due_at ASC NULLS LAST.
   * Joins with scheduled_jobs to include the next pending wake-up time.
   */
  async listTasks(filters: ListTasksFilters = {}): Promise<TaskListRow[]> {
    const { statuses, owner, tag, parentTaskId, dueBefore, limit = 25 } = filters;

    const conditions: string[] = [];
    const queryParams: unknown[] = [];
    let idx = 1;

    if (statuses && statuses.length > 0) {
      conditions.push(`t.status = ANY($${idx++})`);
      queryParams.push(statuses);
    }
    if (owner) {
      conditions.push(`t.owner = $${idx++}`);
      queryParams.push(owner);
    }
    if (tag) {
      conditions.push(`$${idx++} = ANY(t.tags)`);
      queryParams.push(tag);
    }
    if (parentTaskId) {
      conditions.push(`t.parent_task_id = $${idx++}`);
      queryParams.push(parentTaskId);
    }
    if (dueBefore) {
      conditions.push(`t.due_at < $${idx++}`);
      queryParams.push(dueBefore);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    queryParams.push(limit);

    const sql = `
      SELECT
        t.id, t.agent_id, t.intent_anchor, t.title, t.description, t.status, t.progress,
        t.error_budget, t.conversation_id, t.created_at, t.updated_at, t.owner,
        t.waiting_on_contact_id, t.waiting_on_text, t.parent_task_id, t.blocked_by_task_id,
        t.priority, t.due_at, t.source, t.source_agent_id, t.created_by, t.tags,
        (
          SELECT sj.run_at FROM scheduled_jobs sj
          WHERE sj.task_id = t.id AND sj.status = 'pending'
          ORDER BY sj.run_at ASC LIMIT 1
        ) AS next_wake_at
      FROM tasks t
      ${whereClause}
      ORDER BY t.priority DESC, t.due_at ASC NULLS LAST
      LIMIT $${idx}
    `;

    const { rows } = await this.pool.query(sql, queryParams);
    return (rows as Array<DbTaskRow & { next_wake_at: string | null }>).map(r => ({
      ...mapTaskRow(r),
      nextWakeAt: r.next_wake_at,
    }));
  }

  /**
   * Update a task's fields. Validates status transitions: done and cancelled are terminal.
   * When `wakeAt` is provided, existing pending wake-up jobs are cancelled and a new one
   * is created — all in a single CTE for atomicity.
   *
   * Returns the updated task row, or null if the task was not found.
   */
  async updateTask(
    taskId: string,
    updates: UpdateTaskParams,
    callerAgentId?: string,
  ): Promise<TaskRow | null> {
    const current = await this.getTask(taskId);
    if (!current) return null;

    // Enforce terminal-state guard.
    if (updates.status && updates.status !== current.status) {
      if (TERMINAL_STATUSES.has(current.status)) {
        throw new Error(
          `Cannot transition task from '${current.status}' — it is a terminal state.`,
        );
      }
    }

    // Append progress note to progress.notes if provided.
    let newProgress = current.progress;
    if (updates.progressNote) {
      const notes = (Array.isArray(newProgress.notes) ? newProgress.notes : []) as Array<unknown>;
      notes.push({ at: new Date().toISOString(), note: updates.progressNote });
      newProgress = { ...newProgress, notes };
    }

    // Build the SET clause dynamically — only update columns that were supplied.
    const setClauses: string[] = ['updated_at = now()'];
    const updateParams: unknown[] = [];
    let idx = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${idx++}`);
      updateParams.push(updates.status);
    }
    if (updates.priority !== undefined) {
      setClauses.push(`priority = $${idx++}`);
      updateParams.push(updates.priority);
    }
    if (updates.owner !== undefined) {
      setClauses.push(`owner = $${idx++}`);
      updateParams.push(updates.owner);
    }
    if ('dueAt' in updates) {
      setClauses.push(`due_at = $${idx++}`);
      updateParams.push(updates.dueAt ?? null);
    }
    if (updates.tags !== undefined) {
      setClauses.push(`tags = $${idx++}`);
      updateParams.push(updates.tags);
    }
    if (updates.progressNote !== undefined) {
      setClauses.push(`progress = $${idx++}::jsonb`);
      updateParams.push(JSON.stringify(newProgress));
    }
    if ('blockedByTaskId' in updates) {
      setClauses.push(`blocked_by_task_id = $${idx++}`);
      updateParams.push(updates.blockedByTaskId ?? null);
    }

    updateParams.push(taskId); // $N — WHERE id = $N
    const whereIdx = idx;

    // WHERE clause includes the terminal-state guard. If a concurrent write moved
    // the task to 'done' or 'cancelled' between our pre-check and this UPDATE,
    // the guard here ensures we don't overwrite the terminal state. An empty
    // RETURNING is then handled below with a follow-up SELECT.
    const updateSql = `
      UPDATE tasks SET ${setClauses.join(', ')}
      WHERE id = $${whereIdx} AND status NOT IN ('done', 'cancelled')
      RETURNING ${TASK_COLUMNS}
    `;

    // Terminal-status transitions (cancelled / done) always cancel pending wake-up jobs.
    // When wakeAt is also provided the cancel+create is already atomic; the extra
    // _cancel_wake arm here handles the bare status-only path.
    const cancelOnTerminal = (updates.status === 'cancelled' || updates.status === 'done')
      && !updates.wakeAt;

    let updatedRow: DbTaskRow;

    if (updates.wakeAt || cancelOnTerminal) {
      // Atomic CTE: update task + cancel old wake-up jobs + optionally insert new one.
      const wakeAgentIdx = whereIdx + 1;
      const wakeRunAtIdx = updates.wakeAt ? whereIdx + 2 : null;
      const wakeCreatedByIdx = updates.wakeAt ? whereIdx + 3 : null;
      const wakeTzIdx = updates.wakeAt ? whereIdx + 4 : null;

      const cteSql = `
        WITH updated_task AS (
          ${updateSql}
        ),
        _cancel_wake AS (
          UPDATE scheduled_jobs SET status = 'cancelled'
          WHERE task_id = $${whereIdx} AND status = 'pending'
        )${updates.wakeAt ? `,
        _new_wake AS (
          INSERT INTO scheduled_jobs (agent_id, run_at, task_payload, status, next_run_at, created_by, timezone, task_id)
          VALUES ($${wakeAgentIdx}, $${wakeRunAtIdx}, '{"type":"task-wake"}'::jsonb, 'pending',
                  $${wakeRunAtIdx}, $${wakeCreatedByIdx}, $${wakeTzIdx}, $${whereIdx})
        )` : ''}
        SELECT * FROM updated_task
      `;
      const allParams: unknown[] = [...updateParams];
      if (updates.wakeAt) {
        allParams.push(
          // Route the new wake-up job to the task's source agent (the specialist best
          // positioned to resume it). Fall back to the caller, then the task's original
          // creator. This ensures coordinator-reschedules (e.g. backlog sweep) still
          // fire at the right specialist rather than coordinator.
          current.sourceAgentId ?? callerAgentId ?? current.agentId, // $wakeAgentIdx
          updates.wakeAt,                                             // $wakeRunAtIdx
          callerAgentId ?? current.agentId,                          // $wakeCreatedByIdx
          this.timezone,                                             // $wakeTzIdx
        );
      }
      const { rows } = await this.pool.query(cteSql, allParams);
      if (!rows[0]) {
        return await this.resolveEmptyUpdateReturning(taskId);
      }
      updatedRow = rows[0] as DbTaskRow;
    } else {
      const { rows } = await this.pool.query(updateSql, updateParams);
      if (!rows[0]) {
        return await this.resolveEmptyUpdateReturning(taskId);
      }
      updatedRow = rows[0] as DbTaskRow;
    }

    const updated = mapTaskRow(updatedRow);

    try {
      await this.bus.publish('execution', createTaskUpdated({
        taskId: updated.id,
        previousStatus: current.status,
        newStatus: updates.status !== undefined && updates.status !== current.status
          ? updates.status
          : undefined,
        progressNote: updates.progressNote,
        agentId: callerAgentId ?? null,
      }));
    } catch (busErr) {
      this.logger.error({ busErr, taskId: updated.id }, 'task-repo: bus publish failed after updateTask');
    }

    this.logger.info(
      { taskId: updated.id, previousStatus: current.status, newStatus: updated.status },
      'task-repo: updated task',
    );
    return updated;
  }

  /**
   * Called when an UPDATE...RETURNING returns no rows after a confirmed pre-check.
   * Distinguishes "task was deleted concurrently" (return null) from "task reached a
   * terminal state concurrently and the WHERE guard blocked the write" (throw).
   */
  private async resolveEmptyUpdateReturning(taskId: string): Promise<null> {
    const { rows } = await this.pool.query(
      `SELECT id, status FROM tasks WHERE id = $1`,
      [taskId],
    );
    if (!rows[0]) return null;
    const { status } = rows[0] as { status: string };
    throw new Error(
      `task-repo: update rejected — task ${taskId} reached terminal state '${status}' concurrently`,
    );
  }

  /**
   * Set a task to 'done' and cancel any pending wake-up jobs.
   * The update + cancellation happen atomically via a CTE.
   */
  async completeTask(
    taskId: string,
    completionNote?: string,
    callerAgentId?: string,
  ): Promise<TaskRow | null> {
    const current = await this.getTask(taskId);
    if (!current) return null;

    if (TERMINAL_STATUSES.has(current.status)) {
      throw new Error(
        `Cannot complete task — it is already in terminal state '${current.status}'.`,
      );
    }

    // Append completion note to progress.notes if provided.
    const notes = (Array.isArray(current.progress.notes) ? current.progress.notes : []) as Array<unknown>;
    if (completionNote) {
      notes.push({ at: new Date().toISOString(), note: completionNote });
    }
    const newProgress = { ...current.progress, notes };

    // The WHERE guard prevents a concurrent write from moving the task to a terminal
    // state between our pre-check read and this UPDATE.
    const cteSql = `
      WITH done_task AS (
        UPDATE tasks
        SET status = 'done', progress = $1::jsonb, updated_at = now()
        WHERE id = $2 AND status NOT IN ('done', 'cancelled')
        RETURNING ${TASK_COLUMNS}
      ),
      _cancel_wake AS (
        UPDATE scheduled_jobs SET status = 'cancelled'
        WHERE task_id = $2 AND status = 'pending'
      )
      SELECT * FROM done_task
    `;

    const { rows } = await this.pool.query(cteSql, [JSON.stringify(newProgress), taskId]);
    const row = rows[0] as DbTaskRow | undefined;
    if (!row) {
      // Task existed at pre-check time and was not terminal — if RETURNING is empty,
      // the row was either deleted or moved to a terminal state concurrently.
      return await this.resolveEmptyUpdateReturning(taskId);
    }

    const updated = mapTaskRow(row);

    try {
      await this.bus.publish('execution', createTaskCompleted({
        taskId: updated.id,
        completionNote,
        agentId: callerAgentId ?? null,
      }));
    } catch (busErr) {
      this.logger.error({ busErr, taskId: updated.id }, 'task-repo: bus publish failed after completeTask');
    }

    this.logger.info({ taskId: updated.id }, 'task-repo: completed task');
    return updated;
  }

  /**
   * Cancel all pending wake-up jobs for a task without changing the task itself.
   * Available as an explicit hook for callers that need to cancel wake-ups independently
   * of a status transition (e.g. external cleanup). For status='cancelled' and status='done'
   * transitions via updateTask, the cancellation is handled atomically in the CTE.
   */
  async cancelWakeUpJobs(taskId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE scheduled_jobs SET status = 'cancelled' WHERE task_id = $1 AND status = 'pending'`,
      [taskId],
    );
    this.logger.info({ taskId, rowsAffected: result.rowCount }, 'task-repo: cancelled wake-up jobs');
  }
}
