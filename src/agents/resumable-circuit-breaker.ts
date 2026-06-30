// resumable-circuit-breaker.ts — progress-based stall counter + aggregate ceilings (#1176).
//
// Keys the resumable-task breaker on forward progress (cursor or done-count), not error
// count. A paused-with-no-progress continuation increments stallCount; K consecutive
// stalls or a ceiling breach fails the task and escalates instead of looping.

import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { ResumableCeilingsConfig } from '../config.js';
import type { TaskRow } from '../db/queries/tasks.js';
import { getTaskById } from '../db/queries/tasks.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { ResumableCursor } from '../db/resumable-progress.js';
import { computePlanRollup, type PlanStepDescriptor } from '../db/plan-progress.js';
import { createAgentTask } from '../bus/events.js';
import type { ExecutionPausedPayload } from './resumable-task.js';
import { emitResumableThroughputTelemetry } from './resumable-throughput.js';

/** Persisted under tasks.progress.resumableCircuit — separate from the bounded resumable block. */
export interface ResumableCircuitState {
  stallCount: number;
  iterationCount: number;
  /** ISO timestamp — first processed pause; drives wallclock ceiling. */
  startedAt: string;
  totalCostUsd: number;
  lastProgress: { done: number; cursor: ResumableCursor };
}

export type CircuitBreachReason =
  | 'stall_limit'
  | 'max_iterations'
  | 'max_wallclock'
  | 'max_cost';

export interface CircuitBreach {
  reason: CircuitBreachReason;
  message: string;
  state: ResumableCircuitState;
}

export interface ProcessPausedSliceInput {
  paused: ExecutionPausedPayload;
  /** Prior circuit state; absent on the first pause for this task. */
  circuit: ResumableCircuitState | null;
  ceilings: ResumableCeilingsConfig;
  /** Optional slice LLM cost from the runtime execution_paused payload. */
  sliceCostUsd?: number;
  now?: Date;
}

export type ProcessPausedSliceResult =
  | { action: 'continue'; state: ResumableCircuitState }
  | { action: 'breach'; breach: CircuitBreach };

const PROGRESS_KEY = 'resumableCircuit';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseCursor(raw: unknown): ResumableCursor | undefined {
  if (raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (isPlainObject(raw)) return raw as unknown as ResumableCursor;
  return undefined;
}

function parseLastProgress(raw: unknown): ResumableCircuitState['lastProgress'] | undefined {
  if (!isPlainObject(raw)) return undefined;
  const done = raw.done;
  const cursor = parseCursor(raw.cursor);
  if (typeof done !== 'number' || !Number.isFinite(done) || done < 0) return undefined;
  if (cursor === undefined) return undefined;
  return { done, cursor };
}

/** Read circuit state from persisted task progress JSON. */
export function readCircuitState(progress: Record<string, unknown>): ResumableCircuitState | null {
  const raw = progress[PROGRESS_KEY];
  if (!isPlainObject(raw)) return null;

  const stallCount = raw.stallCount;
  const iterationCount = raw.iterationCount;
  const startedAt = raw.startedAt;
  const totalCostUsd = raw.totalCostUsd;
  const lastProgress = parseLastProgress(raw.lastProgress);

  if (
    typeof stallCount !== 'number' || !Number.isInteger(stallCount) || stallCount < 0
    || typeof iterationCount !== 'number' || !Number.isInteger(iterationCount) || iterationCount < 0
    || typeof startedAt !== 'string' || startedAt.length === 0
    || !Number.isFinite(Date.parse(startedAt))
    || typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd) || totalCostUsd < 0
    || !lastProgress
  ) {
    return null;
  }

  return { stallCount, iterationCount, startedAt, totalCostUsd, lastProgress };
}

/** Merge circuit state into a progress object (preserves notes, resumable block, etc.). */
export function mergeCircuitState(
  progress: Record<string, unknown>,
  state: ResumableCircuitState,
): Record<string, unknown> {
  return { ...progress, [PROGRESS_KEY]: state };
}

/** Compare cursors for equality (opaque LLM-authored positions). */
export function cursorsEqual(a: ResumableCursor, b: ResumableCursor): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return isDeepStrictEqual(a, b);
  }
  return false;
}

/**
 * True when done-count increased or the cursor advanced/changed to a new position.
 * Same done with an unchanged cursor is not forward progress.
 */
export function hasForwardProgress(
  previous: ResumableCircuitState['lastProgress'],
  next: ResumableCircuitState['lastProgress'],
): boolean {
  if (next.done > previous.done) return true;
  if (next.done < previous.done) return false;
  return !cursorsEqual(previous.cursor, next.cursor);
}

/** Resolve per-task ceilings: error_budget overrides win over config defaults (#1176 / #883). */
export function resolveResumableCeilings(
  config: ResumableCeilingsConfig,
  errorBudget: Record<string, unknown>,
): ResumableCeilingsConfig {
  const pick = (key: keyof ResumableCeilingsConfig, budgetKey: string): number => {
    const override = errorBudget[budgetKey];
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return override;
    }
    return config[key];
  };
  return {
    maxStalls: pick('maxStalls', 'max_stalls'),
    maxIterations: pick('maxIterations', 'max_iterations'),
    maxWallclockHours: pick('maxWallclockHours', 'max_wallclock_hours'),
    maxCostUsd: pick('maxCostUsd', 'max_cost_usd'),
    maxPlanDepth: pick('maxPlanDepth', 'max_plan_depth'),
    maxReplansPerSubtree: pick('maxReplansPerSubtree', 'max_replans_per_subtree'),
    blockedStepHours: pick('blockedStepHours', 'blocked_step_hours'),
    throughputDivergenceRatio: pick('throughputDivergenceRatio', 'throughput_divergence_ratio'),
  };
}

function breachMessage(reason: CircuitBreachReason, state: ResumableCircuitState, ceilings: ResumableCeilingsConfig): string {
  switch (reason) {
    case 'stall_limit':
      return `Resumable task stalled ${state.stallCount} consecutive slice(s) with no forward progress (limit ${ceilings.maxStalls}).`;
    case 'max_iterations':
      return `Resumable task exceeded iteration ceiling (${state.iterationCount}/${ceilings.maxIterations}).`;
    case 'max_wallclock':
      return `Resumable task exceeded wallclock ceiling (${ceilings.maxWallclockHours}h).`;
    case 'max_cost':
      return `Resumable task exceeded cost ceiling ($${state.totalCostUsd.toFixed(4)}/${ceilings.maxCostUsd.toFixed(2)}).`;
  }
}

function detectBreach(
  state: ResumableCircuitState,
  ceilings: ResumableCeilingsConfig,
  now: Date,
): CircuitBreachReason | null {
  if (state.stallCount >= ceilings.maxStalls) return 'stall_limit';
  if (state.iterationCount >= ceilings.maxIterations) return 'max_iterations';
  const startedMs = Date.parse(state.startedAt);
  if (Number.isFinite(startedMs)) {
    const elapsedHours = (now.getTime() - startedMs) / 3_600_000;
    if (elapsedHours >= ceilings.maxWallclockHours) return 'max_wallclock';
  }
  if (state.totalCostUsd >= ceilings.maxCostUsd) return 'max_cost';
  return null;
}

/**
 * Process a paused slice outcome: update counters, detect stalls/ceilings.
 * Does not persist — caller writes state or fails the task.
 */
export function processPausedSliceOutcome(input: ProcessPausedSliceInput): ProcessPausedSliceResult {
  const now = input.now ?? new Date();
  const nextProgress = { done: input.paused.done, cursor: input.paused.cursor };
  const rawSliceCost = input.sliceCostUsd ?? input.paused.slice_cost_usd ?? 0;
  const sliceCostUsd = Number.isFinite(rawSliceCost) && rawSliceCost >= 0 ? rawSliceCost : 0;

  const base: ResumableCircuitState = input.circuit ?? {
    stallCount: 0,
    iterationCount: 0,
    startedAt: now.toISOString(),
    totalCostUsd: 0,
    lastProgress: nextProgress,
  };

  const madeProgress = input.circuit
    ? hasForwardProgress(input.circuit.lastProgress, nextProgress)
    : true;

  const state: ResumableCircuitState = {
    ...base,
    iterationCount: base.iterationCount + 1,
    totalCostUsd: base.totalCostUsd + Math.max(0, sliceCostUsd),
    lastProgress: nextProgress,
    stallCount: madeProgress ? 0 : base.stallCount + 1,
  };

  const reason = detectBreach(state, input.ceilings, now);
  if (reason) {
    return {
      action: 'breach',
      breach: {
        reason,
        message: breachMessage(reason, state, input.ceilings),
        state,
      },
    };
  }

  return { action: 'continue', state };
}

export interface EscalateCircuitBreachOptions {
  pool: Pool;
  bus: EventBus;
  taskRepo: TaskRepo;
  logger: Logger;
  task: TaskRow;
  breach: CircuitBreach;
  agentId: string;
}

/**
 * Fail the resumable task, cancel continuations, surface to coordinator + CEO backlog.
 * Mirrors the delegation-failure escalation path (#1171).
 */
export async function escalateCircuitBreach(opts: EscalateCircuitBreachOptions): Promise<void> {
  const { task, breach, bus, taskRepo, logger, agentId } = opts;
  const progressNote = [
    breach.message,
    `Progress at breach: ${breach.state.lastProgress.done} done, cursor ${JSON.stringify(breach.state.lastProgress.cursor)}.`,
    `Iterations: ${breach.state.iterationCount}, stalls: ${breach.state.stallCount}, cost: $${breach.state.totalCostUsd.toFixed(4)}.`,
  ].join(' ');

  const updated = await taskRepo.failResumableTask(task.id, {
    progressNote,
    circuitState: breach.state,
    tags: ['needs-attention', 'resumable-circuit-breach'],
  });

  if (!updated) {
    logger.warn({ taskId: task.id }, 'Circuit breach escalation: task not found or already terminal');
    return;
  }

  const notifyContent = [
    'A resumable task hit its progress-based circuit breaker and needs attention.',
    '',
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Agent: ${agentId}`,
    `Reason: ${breach.reason}`,
    breach.message,
    '',
    'Do not re-delegate or schedule continuations for this task. Let the principal know and help them decide next steps.',
  ].join('\n');

  const notifyEvent = createAgentTask({
    agentId: 'coordinator',
    conversationId: `resumable-circuit:${task.id}`,
    channelId: 'scheduler',
    senderId: 'system',
    content: notifyContent,
    parentEventId: task.id,
  });
  try {
    await bus.publish('system', notifyEvent);
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'Failed to notify coordinator of circuit breach');
  }

  try {
    await taskRepo.createTask({
      agentId: 'coordinator',
      title: `Review: resumable task stalled (${task.title})`,
      description: [
        breach.message,
        '',
        `Task ID: ${task.id}`,
        `Specialist: ${task.sourceAgentId ?? agentId}`,
        '',
        progressNote,
      ].join('\n'),
      owner: 'ceo',
      source: 'coordinator',
      tags: ['needs-attention', 'resumable-circuit-breach', breach.reason],
      parentTaskId: task.parentTaskId ?? undefined,
    });
    logger.info({ taskId: task.id, reason: breach.reason }, 'Escalated resumable circuit breach to CEO backlog');
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'Failed to create CEO backlog task for circuit breach');
  }
}

/** Load task, process pause outcome, persist state or escalate. Returns whether to schedule continuation. */
export async function handlePausedSliceForCircuitBreaker(opts: {
  pool: Pool;
  bus: EventBus;
  taskRepo: TaskRepo;
  logger: Logger;
  taskId: string;
  paused: ExecutionPausedPayload;
  ceilings: ResumableCeilingsConfig;
  agentId: string;
  sliceCostUsd?: number;
  parentEventId?: string;
}): Promise<{ scheduleContinuation: boolean; breach?: CircuitBreach }> {
  const task = await getTaskById(opts.pool, opts.taskId);
  if (!task) {
    opts.logger.warn({ taskId: opts.taskId }, 'Circuit breaker: task not found');
    return { scheduleContinuation: false };
  }

  const ceilings = resolveResumableCeilings(opts.ceilings, task.errorBudget);
  const circuit = readCircuitState(task.progress);
  const outcome = processPausedSliceOutcome({
    paused: opts.paused,
    circuit,
    ceilings,
    sliceCostUsd: opts.sliceCostUsd,
  });

  await emitResumableThroughputTelemetry({
    logger: opts.logger,
    bus: opts.bus,
    taskId: opts.taskId,
    agentId: opts.agentId,
    parentEventId: opts.parentEventId,
    resumable: {
      done: opts.paused.done,
      total: opts.paused.total,
      lastSliceUnits: opts.paused.last_slice_units,
    },
    circuit: outcome.action === 'continue' ? outcome.state : outcome.breach.state,
  });

  if (outcome.action === 'breach') {
    opts.logger.warn(
      { taskId: opts.taskId, reason: outcome.breach.reason, state: outcome.breach.state },
      'Resumable circuit breaker tripped',
    );
    await escalateCircuitBreach({
      pool: opts.pool,
      bus: opts.bus,
      taskRepo: opts.taskRepo,
      logger: opts.logger,
      task,
      breach: outcome.breach,
      agentId: opts.agentId,
    });
    return { scheduleContinuation: false, breach: outcome.breach };
  }

  await opts.taskRepo.persistResumableCircuitState(opts.taskId, outcome.state);
  return { scheduleContinuation: true };
}

/** Snapshot of planned-parent frontier progress for the circuit breaker (#1239). */
export interface PlanFrontierSnapshot {
  rollupDone: number;
  /** Children in done / cancelled / failed — terminal since last wake. */
  terminalChildCount: number;
}

const PLAN_FRONTIER_TERMINAL_CHILD_STATUSES = new Set(['done', 'cancelled', 'failed']);

/** Build a frontier snapshot from live child rows. */
export function snapshotPlanFrontier(
  steps: readonly PlanStepDescriptor[],
  childStatusByTaskId: Readonly<Record<string, string>>,
): PlanFrontierSnapshot {
  let terminalChildCount = 0;
  for (const step of steps) {
    if (!step.taskId) continue;
    const status = childStatusByTaskId[step.taskId];
    if (status !== undefined && PLAN_FRONTIER_TERMINAL_CHILD_STATUSES.has(status)) {
      terminalChildCount++;
    }
  }
  const { done: rollupDone } = computePlanRollup(steps, childStatusByTaskId);
  return { rollupDone, terminalChildCount };
}

/** True when rollup advanced or a child reached a terminal status since the last wake. */
export function hasFrontierProgress(
  previous: PlanFrontierSnapshot,
  next: PlanFrontierSnapshot,
): boolean {
  if (next.rollupDone > previous.rollupDone) return true;
  return next.terminalChildCount > previous.terminalChildCount;
}

function snapshotToLastProgress(snapshot: PlanFrontierSnapshot): ResumableCircuitState['lastProgress'] {
  return {
    done: snapshot.rollupDone,
    cursor: { terminalChildren: snapshot.terminalChildCount },
  };
}

export interface ProcessPlanFrontierWakeInput {
  snapshot: PlanFrontierSnapshot;
  circuit: ResumableCircuitState | null;
  ceilings: ResumableCeilingsConfig;
  sliceCostUsd?: number;
  now?: Date;
}

/**
 * Process a planned-parent wake: update counters, detect frontier stalls/ceilings.
 * Does not persist — caller writes state or fails the task.
 */
export function processPlanFrontierWakeOutcome(
  input: ProcessPlanFrontierWakeInput,
): ProcessPausedSliceResult {
  const now = input.now ?? new Date();
  const nextProgress = snapshotToLastProgress(input.snapshot);
  const rawSliceCost = input.sliceCostUsd ?? 0;
  const sliceCostUsd = Number.isFinite(rawSliceCost) && rawSliceCost >= 0 ? rawSliceCost : 0;

  const base: ResumableCircuitState = input.circuit ?? {
    stallCount: 0,
    iterationCount: 0,
    startedAt: now.toISOString(),
    totalCostUsd: 0,
    lastProgress: nextProgress,
  };

  const madeProgress = input.circuit
    ? hasFrontierProgress(
      {
        rollupDone: input.circuit.lastProgress.done,
        terminalChildCount: typeof input.circuit.lastProgress.cursor === 'object'
          && input.circuit.lastProgress.cursor !== null
          && 'terminalChildren' in input.circuit.lastProgress.cursor
          ? Number((input.circuit.lastProgress.cursor as { terminalChildren: number }).terminalChildren)
          : 0,
      },
      input.snapshot,
    )
    : true;

  const state: ResumableCircuitState = {
    ...base,
    iterationCount: base.iterationCount + 1,
    totalCostUsd: base.totalCostUsd + Math.max(0, sliceCostUsd),
    lastProgress: nextProgress,
    stallCount: madeProgress ? 0 : base.stallCount + 1,
  };

  const reason = detectBreach(state, input.ceilings, now);
  if (reason) {
    return {
      action: 'breach',
      breach: {
        reason,
        message: breachMessage(reason, state, input.ceilings),
        state,
      },
    };
  }

  return { action: 'continue', state };
}

/** Load task, process frontier wake, persist state or escalate. Returns whether the parent may continue. */
export async function handlePlanFrontierWakeForCircuitBreaker(opts: {
  pool: Pool;
  bus: EventBus;
  taskRepo: TaskRepo;
  logger: Logger;
  taskId: string;
  snapshot: PlanFrontierSnapshot;
  ceilings: ResumableCeilingsConfig;
  agentId: string;
  sliceCostUsd?: number;
}): Promise<{ continueParent: boolean; breach?: CircuitBreach }> {
  const task = await getTaskById(opts.pool, opts.taskId);
  if (!task) {
    opts.logger.warn({ taskId: opts.taskId }, 'Plan frontier circuit breaker: task not found');
    return { continueParent: false };
  }
  if (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed') {
    opts.logger.debug(
      { taskId: opts.taskId, status: task.status },
      'Plan frontier circuit breaker: task already terminal',
    );
    return { continueParent: false };
  }

  const ceilings = resolveResumableCeilings(opts.ceilings, task.errorBudget);
  const circuit = readCircuitState(task.progress);
  const outcome = processPlanFrontierWakeOutcome({
    snapshot: opts.snapshot,
    circuit,
    ceilings,
    sliceCostUsd: opts.sliceCostUsd,
  });

  if (outcome.action === 'breach') {
    opts.logger.warn(
      { taskId: opts.taskId, reason: outcome.breach.reason, state: outcome.breach.state },
      'Planned-parent frontier circuit breaker tripped',
    );
    await escalateCircuitBreach({
      pool: opts.pool,
      bus: opts.bus,
      taskRepo: opts.taskRepo,
      logger: opts.logger,
      task,
      breach: outcome.breach,
      agentId: opts.agentId,
    });
    return { continueParent: false, breach: outcome.breach };
  }

  await opts.taskRepo.persistResumableCircuitState(opts.taskId, outcome.state);
  return { continueParent: true };
}
