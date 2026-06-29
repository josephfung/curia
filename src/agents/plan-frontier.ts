// plan-frontier.ts — child→parent wake and frontier advancement for planned tasks (#1238).
//
// When a planned child resolves, the platform schedules a near-term parent wake (reusing
// the continuation wake path). On that wake, rollup is recomputed and newly-unblocked
// children are dispatched. The BacklogHeartbeat remains the backstop.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow, DbTaskRow } from '../db/queries/tasks.js';
import { getTaskById, mapTaskRow } from '../db/queries/tasks.js';
import {
  computePlanRollup,
  readPlanBlock,
  type PlanProgressBlock,
} from '../db/plan-progress.js';
import {
  resolveContinuationAgent,
  schedulePlanParentWake,
  taskHasPendingWake,
  isPlanParentWakeEligible,
} from './resumable-continuation.js';

/** created_by marker on child dispatches from frontier advancement. */
export const PLAN_FRONTIER_CHILD_DISPATCH_CREATED_BY = 'plan-frontier';

/** Child statuses that trigger a parent wake. */
export const CHILD_TERMINAL_STATUSES = new Set(['done', 'cancelled', 'failed']);

const DISPATCHABLE_CHILD_STATUSES = new Set(['open', 'waiting', 'blocked']);

export function isChildTerminalStatus(status: string): boolean {
  return CHILD_TERMINAL_STATUSES.has(status);
}

/** Re-export for subscriber/tests — eligibility lives with wake scheduling. */
export { isPlanParentWakeEligible };

/** True when a child row is unblocked and ready for a frontier dispatch wake. */
export function isChildDispatchable(
  child: Pick<TaskRow, 'status' | 'blockedByTaskId'>,
  blockerStatusById: ReadonlyMap<string, string>,
  hasPendingWake: boolean,
): boolean {
  if (!DISPATCHABLE_CHILD_STATUSES.has(child.status)) return false;
  if (hasPendingWake) return false;
  if (!child.blockedByTaskId) return true;
  const blockerStatus = blockerStatusById.get(child.blockedByTaskId);
  return blockerStatus === 'done' || blockerStatus === 'cancelled';
}

export interface HandleChildTerminalResolutionOptions {
  pool: Pool;
  schedulerService: SchedulerService;
  logger: Logger;
  childTaskId: string;
  delaySeconds: number;
  eligibleAgents: Set<string>;
  fallbackAgentId?: string;
}

/**
 * When a child task reaches a terminal status, schedule a near-term wake of its
 * planned parent (if any). Idempotent while a parent wake is already pending.
 */
export async function handleChildTerminalResolution(
  opts: HandleChildTerminalResolutionOptions,
): Promise<void> {
  const child = await getTaskById(opts.pool, opts.childTaskId);
  if (!child?.parentTaskId) return;

  const parent = await getTaskById(opts.pool, child.parentTaskId);
  if (!parent || !isPlanParentWakeEligible(parent)) return;

  await schedulePlanParentWake({
    pool: opts.pool,
    schedulerService: opts.schedulerService,
    logger: opts.logger,
    taskId: parent.id,
    delaySeconds: opts.delaySeconds,
    eligibleAgents: opts.eligibleAgents,
    fallbackAgentId: opts.fallbackAgentId,
  });
}

export interface AdvancePlanFrontierOptions {
  pool: Pool;
  taskRepo: TaskRepo;
  schedulerService: SchedulerService;
  logger: Logger;
  parentTaskId: string;
  eligibleAgents: Set<string>;
  fallbackAgentId?: string;
}

export interface AdvancePlanFrontierResult {
  rollup: { done: number; total: number };
  rollupUpdated: boolean;
  dispatchedChildIds: string[];
}

async function loadTasksByIds(pool: Pool, taskIds: readonly string[]): Promise<Map<string, TaskRow>> {
  if (taskIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT id, agent_id, intent_anchor, title, description, status, progress, error_budget,
            conversation_id, created_at, updated_at, owner, waiting_on_contact_id,
            waiting_on_text, parent_task_id, blocked_by_task_id, priority, due_at,
            source, source_agent_id, created_by, tags, originator
       FROM tasks
      WHERE id = ANY($1::uuid[])`,
    [taskIds],
  );
  const map = new Map<string, TaskRow>();
  for (const row of rows) {
    const task = mapTaskRow(row as DbTaskRow);
    map.set(task.id, task);
  }
  return map;
}

function childStatusMap(children: ReadonlyMap<string, TaskRow>): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const [id, child] of children) {
    statuses[id] = child.status;
  }
  return statuses;
}

async function dispatchChildWake(
  opts: AdvancePlanFrontierOptions,
  child: TaskRow,
): Promise<string | null> {
  if (await taskHasPendingWake(opts.pool, child.id)) return null;

  const agentId = resolveContinuationAgent(child, opts.eligibleAgents, opts.fallbackAgentId ?? 'coordinator');
  const derived = child.source === 'agent' || child.parentTaskId !== null;

  const { jobId } = await opts.schedulerService.enqueueTaskWake({
    taskId: child.id,
    agentId,
    runAt: new Date(),
    createdBy: PLAN_FRONTIER_CHILD_DISPATCH_CREATED_BY,
    originator: child.originator,
    derived,
  });

  opts.logger.info(
    { parentTaskId: opts.parentTaskId, childTaskId: child.id, jobId, agentId },
    'Plan frontier: dispatched unblocked child wake',
  );
  return child.id;
}

/**
 * On a planned-parent wake: recompute the "X of Y" rollup, persist it, and enqueue
 * wakes for newly-unblocked children that are idle and have no pending wake.
 */
export async function advancePlanFrontier(
  opts: AdvancePlanFrontierOptions,
): Promise<AdvancePlanFrontierResult | null> {
  const parent = await opts.taskRepo.getTask(opts.parentTaskId);
  if (!parent) return null;

  const plan = readPlanBlock(parent.progress);
  if (!plan) return null;

  const stepTaskIds = plan.steps
    .map((step) => step.taskId)
    .filter((taskId): taskId is string => taskId !== null);

  const children = await loadTasksByIds(opts.pool, stepTaskIds);
  const blockerIds = new Set<string>();
  for (const child of children.values()) {
    if (child.blockedByTaskId) blockerIds.add(child.blockedByTaskId);
  }
  const blockerStatusById = new Map<string, string>();
  if (blockerIds.size > 0) {
    const blockers = await loadTasksByIds(opts.pool, [...blockerIds]);
    for (const [id, row] of blockers) {
      blockerStatusById.set(id, row.status);
    }
  }

  const rollup = computePlanRollup(plan.steps, childStatusMap(children));
  let rollupUpdated = false;
  let currentPlan: PlanProgressBlock = plan;

  if (rollup.done !== plan.done || rollup.total !== plan.total) {
    const result = await opts.taskRepo.setPlanBlock(
      parent.id,
      {
        steps: plan.steps,
        deliverableStepId: plan.deliverableStepId,
        done: rollup.done,
        total: rollup.total,
        next: plan.next,
      },
      parent.sourceAgentId ?? parent.agentId,
    );
    if ('task' in result) {
      rollupUpdated = true;
      currentPlan = result.block;
      opts.logger.info(
        { parentTaskId: parent.id, done: rollup.done, total: rollup.total },
        'Plan frontier: rollup recomputed',
      );
    }
  }

  const dispatchedChildIds: string[] = [];
  for (const step of currentPlan.steps) {
    if (!step.taskId) continue;
    const child = children.get(step.taskId);
    if (!child) continue;

    const pending = await taskHasPendingWake(opts.pool, child.id);
    if (!isChildDispatchable(child, blockerStatusById, pending)) continue;

    const dispatched = await dispatchChildWake(opts, child);
    if (dispatched) dispatchedChildIds.push(dispatched);
  }

  if (dispatchedChildIds.length > 0) {
    opts.logger.info(
      { parentTaskId: parent.id, dispatchedChildIds },
      'Plan frontier: children dispatched',
    );
  }

  return { rollup, rollupUpdated, dispatchedChildIds };
}
