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
import type { TaskOriginator } from '../contacts/types.js';
import { capOriginatorToParent } from '../contacts/principal.js';
import {
  readPlanBlock,
  preparePlanBlock,
  type PreparePlanBlockInput,
  type PlanProgressBlock,
  type PlanWriteResult,
} from './plan-progress.js';
import {
  readResumableBlock,
  prepareResumableBlock,
  type PrepareResumableBlockInput,
  type ResumableProgressBlock,
  type ResumableWriteResult,
} from './resumable-progress.js';
import { prepareResumableBlockWithSpill } from './resumable-accumulator-spill.js';
import type { WorkingDocsRepo } from './working-docs-repo.js';
import { type ResumableCircuitState } from '../agents/resumable-circuit-breaker.js';
import type { PlanAdaptiveState } from '../agents/plan-adaptive-replan.js';

// All SELECT / RETURNING clauses use this column list. Centralised so a schema
// change only needs updating in one place.
const TASK_COLUMNS = `
  id, agent_id, intent_anchor, title, description, status, progress, error_budget,
  conversation_id, created_at, updated_at, owner, waiting_on_contact_id,
  waiting_on_text, parent_task_id, blocked_by_task_id, priority, due_at,
  source, source_agent_id, created_by, tags, originator
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
  /** Lineage to stamp on the task (#1125) — copied from the creating event's originator
   *  (ctx.taskMetadata.originator). For child tasks (parentTaskId set) it is capped to the
   *  parent's lineage, never above it. Absent/null → no lineage (agent / no-bypass). */
  originator?: TaskOriginator | null;
  /** When true, stamps error_budget.resumable so the checkpoint harness activates (#1173). */
  resumable?: boolean;
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

/** Active child statuses reconciled when a parent reaches a terminal state (#1239). */
const RECONCILABLE_CHILD_STATUSES = ['open', 'in_progress', 'waiting', 'blocked'];

type DbQueryable = Pick<Pool, 'query'>;

interface ReconciledChildRow {
  id: string;
  previous_status: string;
}

export class TaskRepo {
  constructor(
    private readonly pool: Pool,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly timezone: string = 'UTC',
    private readonly workingDocsRepo?: WorkingDocsRepo,
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
      originator,
      resumable,
    } = params;

    const resolvedCreatedBy = createdBy ?? agentId;
    const resolvedIntentAnchor = intentAnchor ?? title;
    const errorBudgetJson = resumable ? JSON.stringify({ resumable: true }) : '{}';

    // Resolve the lineage to stamp (#1125). For a child task, cap the creating event's
    // originator to the parent's lineage so a child can never carry standing above its parent.
    // The parent fetch is an extra round-trip on the child-creation path only (rare).
    let resolvedOriginator: TaskOriginator | null = originator ?? null;
    if (parentTaskId) {
      const parent = await this.getTask(parentTaskId);
      resolvedOriginator = capOriginatorToParent(resolvedOriginator, parent?.originator ?? null);
    }
    const originatorJson = resolvedOriginator ? JSON.stringify(resolvedOriginator) : null;

    // Always insert with 'open' status for skill-created tasks.
    const taskInsertSql = `
      INSERT INTO tasks (
        agent_id, title, intent_anchor, description, status, progress, error_budget,
        owner, parent_task_id, blocked_by_task_id, priority, due_at, tags,
        waiting_on_contact_id, waiting_on_text, source, source_agent_id, created_by, originator
      )
      VALUES ($1, $2, $3, $4, 'open', '{"notes":[]}'::jsonb, $17::jsonb,
              $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
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
      originatorJson,
      errorBudgetJson,
    ];

    let row: DbTaskRow;

    if (wakeAt) {
      // Atomic CTE: insert task + insert linked one-shot wake-up job in one round-trip.
      // The task_payload carries minimal context; the dispatcher (issue 4) loads the full
      // task from tasks.id via the scheduled_jobs.task_id FK.
      //
      // The wake job carries the task's `originator` (selected straight from new_task, so it is
      // definitionally the same, parent-capped lineage stamped on the task) but writes NO `standing`
      // envelope (#1153). A `wake_at` time is pre-chosen, so this is a pre-authorized deferral, the
      // same category as a `scheduler-create` job: fireJob threads `job.originator` onto the fired
      // agent.task but mints no `wakeContext`, so it KEEPS its originator at fire time and is NOT
      // subject to the heartbeat bypass ladder (the time was already decided). It is still not a live
      // principal turn, so `elevated` authority primitives remain blocked on wake (see design §3b).
      const cteSql = `
        WITH new_task AS (
          INSERT INTO tasks (
            agent_id, title, intent_anchor, description, status, progress, error_budget,
            owner, parent_task_id, blocked_by_task_id, priority, due_at, tags,
            waiting_on_contact_id, waiting_on_text, source, source_agent_id, created_by, originator
          )
          VALUES ($1, $2, $3, $4, 'open', '{"notes":[]}'::jsonb, $17::jsonb,
                  $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
          RETURNING ${TASK_COLUMNS}
        ),
        _wake_job AS (
          INSERT INTO scheduled_jobs (agent_id, run_at, task_payload, status, next_run_at, created_by, timezone, task_id, originator)
          SELECT $18, $19, '{"type":"task-wake"}'::jsonb, 'pending', $19, $20, $21, new_task.id, new_task.originator
          FROM new_task
        )
        SELECT * FROM new_task
      `;
      const { rows } = await this.pool.query(cteSql, [
        ...taskParams,
        agentId,           // $18 — scheduled_jobs.agent_id
        wakeAt,            // $19 — run_at / next_run_at
        resolvedCreatedBy, // $20 — created_by
        this.timezone,     // $21 — timezone
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

  /** Walk parent_task_id links to the project-root task (#1210). Returns null when not found. */
  async resolveProjectRootTaskId(taskId: string): Promise<string | null> {
    let currentId: string | null = taskId;
    let rootId: string | null = null;
    const seen = new Set<string>();

    while (currentId) {
      if (seen.has(currentId)) return null;
      seen.add(currentId);
      const task = await this.getTask(currentId);
      if (!task) return null;
      rootId = task.id;
      currentId = task.parentTaskId;
    }

    return rootId;
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
        t.priority, t.due_at, t.source, t.source_agent_id, t.created_by, t.tags, t.originator,
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
    // Append progress note atomically — jsonb_set preserves sibling blocks (plan, resumable, etc.).
    if (updates.progressNote) {
      const noteEntry = { at: new Date().toISOString(), note: updates.progressNote };
      setClauses.push(`progress = jsonb_set(
        COALESCE(progress, '{}'::jsonb),
        '{notes}',
        COALESCE(progress->'notes', '[]'::jsonb) || $${idx++}::jsonb,
        true
      )`);
      updateParams.push(JSON.stringify([noteEntry]));
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

    const transitioningToTerminal = updates.status !== undefined
      && updates.status !== current.status
      && (updates.status === 'done' || updates.status === 'cancelled');

    const executeUpdate = async (executor: DbQueryable): Promise<DbTaskRow | null> => {
      if (updates.wakeAt || cancelOnTerminal) {
        const wakeAgentIdx = whereIdx + 1;
        const wakeRunAtIdx = updates.wakeAt ? whereIdx + 2 : null;
        const wakeCreatedByIdx = updates.wakeAt ? whereIdx + 3 : null;
        const wakeTzIdx = updates.wakeAt ? whereIdx + 4 : null;
        const wakeOriginatorIdx = updates.wakeAt ? whereIdx + 5 : null;

        const cteSql = `
        WITH updated_task AS (
          ${updateSql}
        ),
        _cancel_wake AS (
          UPDATE scheduled_jobs SET status = 'cancelled'
          WHERE task_id = $${whereIdx} AND status = 'pending'
        )${updates.wakeAt ? `,
        _new_wake AS (
          INSERT INTO scheduled_jobs (agent_id, run_at, task_payload, status, next_run_at, created_by, timezone, task_id, originator)
          VALUES ($${wakeAgentIdx}, $${wakeRunAtIdx}, '{"type":"task-wake"}'::jsonb, 'pending',
                  $${wakeRunAtIdx}, $${wakeCreatedByIdx}, $${wakeTzIdx}, $${whereIdx}, $${wakeOriginatorIdx}::jsonb)
        )` : ''}
        SELECT * FROM updated_task
      `;
        const allParams: unknown[] = [...updateParams];
        if (updates.wakeAt) {
          allParams.push(
            current.sourceAgentId ?? current.agentId ?? callerAgentId,
            updates.wakeAt,
            callerAgentId ?? current.agentId,
            this.timezone,
            current.originator ? JSON.stringify(current.originator) : null,
          );
        }
        const { rows } = await executor.query(cteSql, allParams);
        return (rows[0] as DbTaskRow | undefined) ?? null;
      }

      const { rows } = await executor.query(updateSql, updateParams);
      return (rows[0] as DbTaskRow | undefined) ?? null;
    };

    let updatedRow: DbTaskRow;
    let reconciledChildren: ReconciledChildRow[] = [];

    if (transitioningToTerminal) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const row = await executeUpdate(client);
        if (!row) {
          await client.query('ROLLBACK');
          return await this.resolveEmptyUpdateReturning(taskId);
        }
        reconciledChildren = await this.runReconcileChildrenQuery(
          client,
          taskId,
          `reconciled: parent ${taskId} ${updates.status}`,
        );
        await client.query('COMMIT');
        updatedRow = row;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      const row = await executeUpdate(this.pool);
      if (!row) {
        return await this.resolveEmptyUpdateReturning(taskId);
      }
      updatedRow = row;
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

    if (reconciledChildren.length > 0) {
      const reason = `reconciled: parent ${taskId} ${updates.status}`;
      await this.publishReconcileChildEvents(reconciledChildren, reason, callerAgentId, taskId);
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

    const noteEntry = completionNote
      ? { at: new Date().toISOString(), note: completionNote }
      : null;

    const cteSql = noteEntry
      ? `
      WITH done_task AS (
        UPDATE tasks
        SET status = 'done',
            progress = jsonb_set(
              COALESCE(progress, '{}'::jsonb),
              '{notes}',
              COALESCE(progress->'notes', '[]'::jsonb) || $1::jsonb,
              true
            ),
            updated_at = now()
        WHERE id = $2 AND status NOT IN ('done', 'cancelled')
        RETURNING ${TASK_COLUMNS}
      ),
      _cancel_wake AS (
        UPDATE scheduled_jobs SET status = 'cancelled'
        WHERE task_id = $2 AND status = 'pending'
      )
      SELECT * FROM done_task
    `
      : `
      WITH done_task AS (
        UPDATE tasks
        SET status = 'done', updated_at = now()
        WHERE id = $1 AND status NOT IN ('done', 'cancelled')
        RETURNING ${TASK_COLUMNS}
      ),
      _cancel_wake AS (
        UPDATE scheduled_jobs SET status = 'cancelled'
        WHERE task_id = $1 AND status = 'pending'
      )
      SELECT * FROM done_task
    `;

    const queryParams = noteEntry
      ? [JSON.stringify([noteEntry]), taskId]
      : [taskId];

    const client = await this.pool.connect();
    let row: DbTaskRow | undefined;
    let reconciledChildren: ReconciledChildRow[] = [];
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(cteSql, queryParams);
      row = rows[0] as DbTaskRow | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return await this.resolveEmptyUpdateReturning(taskId);
      }
      reconciledChildren = await this.runReconcileChildrenQuery(
        client,
        taskId,
        `reconciled: parent ${taskId} done`,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
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

    if (reconciledChildren.length > 0) {
      await this.publishReconcileChildEvents(
        reconciledChildren,
        `reconciled: parent ${taskId} done`,
        callerAgentId,
        taskId,
      );
    }

    this.logger.info({ taskId: updated.id }, 'task-repo: completed task');
    return updated;
  }

  private async runReconcileChildrenQuery(
    executor: DbQueryable,
    taskId: string,
    reason: string,
  ): Promise<ReconciledChildRow[]> {
    const noteEntry = { at: new Date().toISOString(), note: reason };

    const { rows } = await executor.query<ReconciledChildRow>(
      `WITH RECURSIVE descendants AS (
         SELECT id, status FROM tasks WHERE parent_task_id = $1
         UNION ALL
         SELECT t.id, t.status FROM tasks t
         INNER JOIN descendants d ON t.parent_task_id = d.id
       ),
       to_reconcile AS (
         SELECT id, status AS previous_status FROM descendants
         WHERE status = ANY($2::text[])
       ),
       cancelled AS (
         UPDATE tasks
            SET status = 'cancelled',
                progress = jsonb_set(
                  COALESCE(progress, '{}'::jsonb),
                  '{notes}',
                  COALESCE(progress->'notes', '[]'::jsonb) || $3::jsonb,
                  true
                ),
                updated_at = now()
          WHERE id IN (SELECT id FROM to_reconcile)
            AND status = ANY($2::text[])
          RETURNING id
       ),
       _cancel_wakes AS (
         UPDATE scheduled_jobs SET status = 'cancelled'
          WHERE task_id IN (SELECT id FROM to_reconcile)
            AND status IN ('pending', 'running')
       )
       SELECT c.id, tr.previous_status
         FROM cancelled c
         JOIN to_reconcile tr ON tr.id = c.id`,
      [taskId, RECONCILABLE_CHILD_STATUSES, JSON.stringify([noteEntry])],
    );

    return rows;
  }

  private async publishReconcileChildEvents(
    rows: readonly ReconciledChildRow[],
    reason: string,
    callerAgentId: string | undefined,
    parentTaskId: string,
  ): Promise<void> {
    for (const row of rows) {
      try {
        await this.bus.publish('execution', createTaskUpdated({
          taskId: row.id,
          previousStatus: row.previous_status,
          newStatus: 'cancelled',
          progressNote: reason,
          agentId: callerAgentId ?? null,
        }));
      } catch (busErr) {
        this.logger.error({ busErr, taskId: row.id }, 'task-repo: bus publish failed after reconcileChildren');
      }
    }

    if (rows.length > 0) {
      this.logger.info(
        { parentTaskId, cancelledChildIds: rows.map((r) => r.id), reason },
        'task-repo: reconciled open descendant children',
      );
    }
  }

  /**
   * Recursively cancel non-terminal descendant tasks and their pending wakes when a
   * parent goal completes, is cancelled, or is superseded (#1239).
   */
  async reconcileChildren(
    taskId: string,
    reason: string,
    callerAgentId?: string,
  ): Promise<string[]> {
    const rows = await this.runReconcileChildrenQuery(this.pool, taskId, reason);
    await this.publishReconcileChildEvents(rows, reason, callerAgentId, taskId);
    return rows.map((r) => r.id);
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

  /** Read the typed resumable block from a task's progress JSONB. */
  async getResumableBlock(taskId: string): Promise<ResumableProgressBlock | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;
    return readResumableBlock(task.progress);
  }

  /**
   * Persist a resumable checkpoint under progress.resumable. Enforces inline accumulator
   * and block size caps — inline overflow spills to the document workspace (#1210).
   */
  async setResumableBlock(
    taskId: string,
    input: PrepareResumableBlockInput,
    callerAgentId?: string,
  ): Promise<{ task: TaskRow; block: ResumableProgressBlock } | ResumableWriteResult> {
    const current = await this.getTask(taskId);
    if (!current) {
      return { ok: false, code: 'invalid_block', message: `task not found: ${taskId}` };
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      return { ok: false, code: 'invalid_block', message: `task ${taskId} is in a terminal state` };
    }

    let prepared = prepareResumableBlock(input);
    if (!prepared.ok && prepared.code === 'inline_accumulator_overflow' && this.workingDocsRepo) {
      const rootTaskId = await this.resolveProjectRootTaskId(taskId);
      if (!rootTaskId) {
        return { ok: false, code: 'invalid_block', message: `task not found: ${taskId}` };
      }
      prepared = await prepareResumableBlockWithSpill(input, {
        workingDocsRepo: this.workingDocsRepo,
        rootTaskId,
        taskId,
        agentId: callerAgentId,
      });
    }
    if (!prepared.ok) return prepared;

    const { rows } = await this.pool.query(
      `UPDATE tasks
          SET progress = jsonb_set(COALESCE(progress, '{}'::jsonb), '{resumable}', $1::jsonb, true),
              updated_at = now()
        WHERE id = $2
          AND status NOT IN ('done', 'cancelled')
        RETURNING ${TASK_COLUMNS}`,
      [JSON.stringify(prepared.block), taskId],
    );
    const row = rows[0] as DbTaskRow | undefined;
    if (!row) {
      const currentTask = await this.getTask(taskId);
      if (!currentTask) {
        return { ok: false, code: 'invalid_block', message: `task not found: ${taskId}` };
      }
      if (TERMINAL_STATUSES.has(currentTask.status)) {
        return { ok: false, code: 'invalid_block', message: `task ${taskId} is in a terminal state` };
      }
      throw new Error(`task-repo: setResumableBlock update returned no row for non-terminal task ${taskId}`);
    }

    const updated = mapTaskRow(row);

    try {
      await this.bus.publish('execution', createTaskUpdated({
        taskId: updated.id,
        previousStatus: current.status,
        agentId: callerAgentId ?? null,
      }));
    } catch (busErr) {
      this.logger.error({ busErr, taskId: updated.id }, 'task-repo: bus publish failed after setResumableBlock');
    }

    this.logger.info(
      { taskId: updated.id, done: prepared.block.done, total: prepared.block.total },
      'task-repo: persisted resumable checkpoint',
    );
    return { task: updated, block: prepared.block };
  }

  /** Read the typed plan block from a task's progress JSONB. */
  async getPlanBlock(taskId: string): Promise<PlanProgressBlock | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;
    return readPlanBlock(task.progress);
  }

  /**
   * Persist a plan under progress.plan. Enforces the block size cap — descriptors only,
   * no per-item payloads inline (#1236).
   */
  async setPlanBlock(
    taskId: string,
    input: PreparePlanBlockInput,
    callerAgentId?: string,
  ): Promise<{ task: TaskRow; block: PlanProgressBlock } | PlanWriteResult> {
    const current = await this.getTask(taskId);
    if (!current) {
      return { ok: false, code: 'invalid_block', message: `task not found: ${taskId}` };
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      return { ok: false, code: 'invalid_block', message: `task ${taskId} is in a terminal state` };
    }

    const prepared = preparePlanBlock(input);
    if (!prepared.ok) return prepared;

    const { rows } = await this.pool.query(
      `UPDATE tasks
          SET progress = jsonb_set(COALESCE(progress, '{}'::jsonb), '{plan}', $1::jsonb, true),
              updated_at = now()
        WHERE id = $2
          AND status NOT IN ('done', 'cancelled')
        RETURNING ${TASK_COLUMNS}`,
      [JSON.stringify(prepared.block), taskId],
    );
    const row = rows[0] as DbTaskRow | undefined;
    if (!row) {
      const currentTask = await this.getTask(taskId);
      if (!currentTask) {
        return { ok: false, code: 'invalid_block', message: `task not found: ${taskId}` };
      }
      if (TERMINAL_STATUSES.has(currentTask.status)) {
        return { ok: false, code: 'invalid_block', message: `task ${taskId} is in a terminal state` };
      }
      throw new Error(`task-repo: setPlanBlock update returned no row for non-terminal task ${taskId}`);
    }

    const updated = mapTaskRow(row);

    try {
      await this.bus.publish('execution', createTaskUpdated({
        taskId: updated.id,
        previousStatus: current.status,
        agentId: callerAgentId ?? null,
      }));
    } catch (busErr) {
      this.logger.error({ busErr, taskId: updated.id }, 'task-repo: bus publish failed after setPlanBlock');
    }

    this.logger.info(
      { taskId: updated.id, done: prepared.block.done, total: prepared.block.total },
      'task-repo: persisted plan block',
    );
    return { task: updated, block: prepared.block };
  }

  /** Persist progress.resumableCircuit counters after a healthy paused slice (#1176). */
  async persistResumableCircuitState(taskId: string, state: ResumableCircuitState): Promise<void> {
    await this.pool.query(
      `UPDATE tasks
          SET progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object('resumableCircuit', $1::jsonb),
              updated_at = now()
        WHERE id = $2
          AND status NOT IN ('done', 'cancelled', 'failed')`,
      [JSON.stringify(state), taskId],
    );
  }

  /** Persist progress.planAdaptive state (divergence signals, depth counters) (#1266).
   *  Does not touch updated_at — child blocked-since uses updatedAt as its signal proxy. */
  async persistPlanAdaptiveState(taskId: string, state: PlanAdaptiveState): Promise<void> {
    await this.pool.query(
      `UPDATE tasks
          SET progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object('planAdaptive', $1::jsonb)
        WHERE id = $2
          AND status NOT IN ('done', 'cancelled', 'failed')`,
      [JSON.stringify(state), taskId],
    );
  }

  /**
   * Fail a resumable task on circuit-breaker breach: status failed, cancel wakes,
   * merge circuit state + progress note, add escalation tags, and reconcile
   * (cancel) open descendant children.
   *
   * `failed` is a terminal state just like `done`/`cancelled`, so it must run the
   * same child reconciliation those paths do — otherwise a planned parent that the
   * circuit-breaker fails leaves its open children behind for the BacklogHeartbeat
   * to re-poke forever, which is exactly the orphaned-subtask futility loop
   * (memo gap #6) the plan primitive exists to close (#1177 closeout).
   */
  async failResumableTask(
    taskId: string,
    options: {
      progressNote: string;
      circuitState: ResumableCircuitState;
      tags: string[];
    },
  ): Promise<TaskRow | null> {
    const current = await this.getTask(taskId);
    if (!current) return null;
    if (TERMINAL_STATUSES.has(current.status) || current.status === 'failed') {
      return current;
    }

    const notes = [{ at: new Date().toISOString(), note: options.progressNote }];
    const mergedTags = [...new Set([...current.tags, ...options.tags])];
    const reconcileReason = `reconciled: parent ${taskId} failed`;

    // The parent-fail UPDATE and the descendant reconciliation run in one
    // transaction so a failed parent can never be observed with open children
    // (mirrors completeTask's atomic reconcile).
    const client = await this.pool.connect();
    let row: DbTaskRow | undefined;
    let reconciledChildren: ReconciledChildRow[] = [];
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `WITH updated_task AS (
           UPDATE tasks
              SET status = 'failed',
                  progress = COALESCE(progress, '{}'::jsonb)
                    || jsonb_build_object('resumableCircuit', $1::jsonb)
                    || jsonb_build_object('notes', COALESCE(progress->'notes', '[]'::jsonb) || $2::jsonb),
                  tags = $3::text[],
                  updated_at = now()
            WHERE id = $4
              AND status NOT IN ('done', 'cancelled', 'failed')
            RETURNING ${TASK_COLUMNS}
         ),
         _cancel_wake AS (
           UPDATE scheduled_jobs SET status = 'cancelled'
            WHERE task_id = $4 AND status IN ('pending', 'running')
         )
         SELECT * FROM updated_task`,
        [JSON.stringify(options.circuitState), JSON.stringify(notes), mergedTags, taskId],
      );
      row = rows[0] as DbTaskRow | undefined;
      if (!row) {
        // The row flipped to a terminal status (or vanished) between getTask and
        // this UPDATE. Unlike completeTask we return current truth rather than
        // throwing — failResumableTask is idempotent terminalization (the top
        // guard already treats an already-terminal task as a no-op success).
        await client.query('ROLLBACK');
        return await this.getTask(taskId);
      }
      reconciledChildren = await this.runReconcileChildrenQuery(client, taskId, reconcileReason);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const updated = mapTaskRow(row);
    try {
      await this.bus.publish('execution', createTaskUpdated({
        taskId: updated.id,
        previousStatus: current.status,
        newStatus: 'failed',
        progressNote: options.progressNote,
        agentId: null,
      }));
    } catch (busErr) {
      this.logger.error({ busErr, taskId }, 'task-repo: bus publish failed after failResumableTask');
    }

    // System-triggered failure has no caller agent (matches the null agentId above).
    if (reconciledChildren.length > 0) {
      await this.publishReconcileChildEvents(reconciledChildren, reconcileReason, undefined, taskId);
    }

    this.logger.warn({ taskId }, 'task-repo: resumable task failed by circuit breaker');
    return updated;
  }
}
