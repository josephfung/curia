// resumable-continuation.ts — near-term self-wake for paused resumable tasks (#1175).
//
// When a specialist emits execution_paused, the platform schedules exactly one pending
// continuation via scheduled_jobs (created_by = 'resumable-continuation'). The hourly
// BacklogHeartbeat remains the backstop when a continuation is lost.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { TaskRow } from '../db/queries/tasks.js';
import { getTaskById } from '../db/queries/tasks.js';
import { readPlanBlock } from '../db/plan-progress.js';
import { readResumableBlock } from '../db/resumable-progress.js';
import { isResumableTask } from './resumable-task.js';

/** created_by marker on continuation wakes — distinguishes them from heartbeat wakes. */
export const RESUMABLE_CONTINUATION_CREATED_BY = 'resumable-continuation';

export interface ScheduleResumableContinuationOptions {
  pool: Pool;
  schedulerService: SchedulerService;
  logger: Logger;
  taskId: string;
  /** Seconds until the continuation fires. From tasks.resumableContinuationSeconds. */
  delaySeconds: number;
  /** Heartbeat-eligible agent names — source_agent_id must be in this set or we fall back. */
  eligibleAgents: Set<string>;
  /** Wake target when source_agent_id is null or not eligible. Default 'coordinator'. */
  fallbackAgentId?: string;
}

export type ScheduleResumableContinuationResult =
  | { scheduled: true; jobId: string; agentId: string; runAt: Date }
  | { scheduled: false; reason: 'task_not_found' | 'not_resumable' | 'no_checkpoint' | 'pending_wake_exists' };

export type SchedulePlanParentWakeResult =
  | { scheduled: true; jobId: string; agentId: string; runAt: Date }
  | { scheduled: false; reason: 'task_not_found' | 'not_planned_parent' | 'pending_wake_exists' };

const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled']);

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** True when the task already has a pending or running scheduled_jobs wake. */
export async function taskHasPendingWake(pool: Pool, taskId: string): Promise<boolean> {
  const { rows } = await pool.query<{ pending: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM scheduled_jobs
        WHERE task_id = $1 AND status IN ('pending', 'running')
     ) AS pending`,
    [taskId],
  );
  return rows[0]!.pending;
}

/** Resolve the agent that should receive the continuation wake. */
export function resolveContinuationAgent(
  task: Pick<TaskRow, 'sourceAgentId'>,
  eligibleAgents: Set<string>,
  fallbackAgentId = 'coordinator',
): string {
  if (task.sourceAgentId && eligibleAgents.has(task.sourceAgentId)) {
    return task.sourceAgentId;
  }
  return fallbackAgentId;
}

/** Whether a planned parent is eligible for a frontier-advancement wake (#1238). */
export function isPlanParentWakeEligible(task: TaskRow): boolean {
  if (TERMINAL_TASK_STATUSES.has(task.status)) return false;
  return readPlanBlock(task.progress) !== null;
}

/** Whether a task row is eligible for a resumable continuation wake. */
export function isContinuationEligible(task: TaskRow): boolean {
  const bound = {
    taskId: task.id,
    errorBudget: task.errorBudget,
    tags: task.tags,
    progress: task.progress,
  };
  if (!isResumableTask(bound)) return false;
  return readResumableBlock(task.progress) !== null;
}

interface EnqueueContinuationWakeOptions {
  pool: Pool;
  schedulerService: SchedulerService;
  logger: Logger;
  task: TaskRow;
  taskId: string;
  delaySeconds: number;
  eligibleAgents: Set<string>;
  fallbackAgentId: string;
  logLabel: string;
}

async function enqueueContinuationWake(
  opts: EnqueueContinuationWakeOptions,
): Promise<
  | { scheduled: true; jobId: string; agentId: string; runAt: Date }
  | { scheduled: false; reason: 'pending_wake_exists' }
> {
  const { pool, schedulerService, logger, task, taskId, delaySeconds, eligibleAgents, fallbackAgentId, logLabel } = opts;

  if (await taskHasPendingWake(pool, taskId)) {
    logger.debug({ taskId }, `${logLabel}: pending wake already exists — skipping`);
    return { scheduled: false, reason: 'pending_wake_exists' };
  }

  const agentId = resolveContinuationAgent(task, eligibleAgents, fallbackAgentId);
  const derived = task.source === 'agent' || task.parentTaskId !== null;
  const runAt = new Date(Date.now() + delaySeconds * 1000);

  try {
    const { jobId } = await schedulerService.enqueueTaskWake({
      taskId,
      agentId,
      runAt,
      createdBy: RESUMABLE_CONTINUATION_CREATED_BY,
      originator: task.originator,
      derived,
    });

    logger.info(
      { taskId, jobId, agentId, runAt: runAt.toISOString(), delaySeconds },
      `${logLabel} wake scheduled`,
    );

    return { scheduled: true, jobId, agentId, runAt };
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      logger.debug({ taskId }, `${logLabel}: concurrent wake insert lost race — skipping`);
      return { scheduled: false, reason: 'pending_wake_exists' };
    }
    throw err;
  }
}

/**
 * Enqueue a single near-term continuation wake for a paused resumable task.
 * Idempotent while a pending/running wake already exists for the task.
 * Duplicate inserts are also blocked by migration 067's partial unique index.
 */
export async function scheduleResumableContinuation(
  opts: ScheduleResumableContinuationOptions,
): Promise<ScheduleResumableContinuationResult> {
  const { pool, logger, taskId, delaySeconds, eligibleAgents } = opts;
  const fallbackAgentId = opts.fallbackAgentId ?? 'coordinator';

  const task = await getTaskById(pool, taskId);
  if (!task) {
    logger.debug({ taskId }, 'Resumable continuation: task not found — skipping');
    return { scheduled: false, reason: 'task_not_found' };
  }

  if (!isContinuationEligible(task)) {
    logger.debug({ taskId }, 'Resumable continuation: task not resumable or has no checkpoint — skipping');
    if (!isResumableTask({ errorBudget: task.errorBudget, tags: task.tags, progress: task.progress })) {
      return { scheduled: false, reason: 'not_resumable' };
    }
    return { scheduled: false, reason: 'no_checkpoint' };
  }

  const result = await enqueueContinuationWake({
    pool,
    schedulerService: opts.schedulerService,
    logger,
    task,
    taskId,
    delaySeconds,
    eligibleAgents,
    fallbackAgentId,
    logLabel: 'Resumable continuation',
  });

  if (!result.scheduled) {
    return { scheduled: false, reason: 'pending_wake_exists' };
  }
  return result;
}

/**
 * Enqueue a single near-term parent wake when a planned child resolves (#1238).
 * Reuses the continuation wake path and dedup index (067).
 */
export async function schedulePlanParentWake(
  opts: ScheduleResumableContinuationOptions,
): Promise<SchedulePlanParentWakeResult> {
  const { pool, logger, taskId, delaySeconds, eligibleAgents } = opts;
  const fallbackAgentId = opts.fallbackAgentId ?? 'coordinator';

  const task = await getTaskById(pool, taskId);
  if (!task) {
    logger.debug({ taskId }, 'Plan parent wake: task not found — skipping');
    return { scheduled: false, reason: 'task_not_found' };
  }

  if (!isPlanParentWakeEligible(task)) {
    logger.debug({ taskId }, 'Plan parent wake: task has no plan block — skipping');
    return { scheduled: false, reason: 'not_planned_parent' };
  }

  const result = await enqueueContinuationWake({
    pool,
    schedulerService: opts.schedulerService,
    logger,
    task,
    taskId,
    delaySeconds,
    eligibleAgents,
    fallbackAgentId,
    logLabel: 'Plan parent wake',
  });

  if (!result.scheduled) {
    return { scheduled: false, reason: 'pending_wake_exists' };
  }
  return result;
}
