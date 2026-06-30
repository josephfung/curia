// plan-adaptive-replan.ts — divergence triggers + depth bounds for adaptive re-planning (#1266).
//
// On a frontier wake, detects when reality diverges from the plan and surfaces advisory
// re-plan signals to the parent (LLM decides). Bounds re-decomposition depth and
// re-plan count per subtree; a breach escalates instead of looping.

import type { EventBus } from '../bus/bus.js';
import { createAgentTask } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ResumableCeilingsConfig } from '../config.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { PlanStepDescriptor } from '../db/plan-progress.js';
import { readResumableBlock } from '../db/resumable-progress.js';
import {
  readCircuitState,
  type ResumableCircuitState,
} from './resumable-circuit-breaker.js';
import { computeResumableThroughput } from './resumable-throughput.js';

const PROGRESS_KEY = 'planAdaptive';

export type PlanDivergenceReason =
  | 'child_failed'
  | 'child_cancelled'
  | 'throughput_below_estimate'
  | 'step_over_blocked';

export interface PlanDivergenceSignal {
  reason: PlanDivergenceReason;
  stepId?: string;
  childTaskId?: string;
  message: string;
}

export interface PlanAdaptiveState {
  /** How deep this task sits in the plan-decomposition tree (root plan = 1). */
  planDepth: number;
  /** How many times plan() has been re-run on this task. */
  replanCount: number;
  /** Advisory signals surfaced on the next parent wake; empty when healthy. */
  pendingSignals: PlanDivergenceSignal[];
}

export type PlanAdaptiveBreachReason = 'max_plan_depth' | 'max_replans';

export interface PlanAdaptiveBreach {
  reason: PlanAdaptiveBreachReason;
  message: string;
  planDepth: number;
  replanCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseSignal(raw: unknown): PlanDivergenceSignal | undefined {
  if (!isPlainObject(raw)) return undefined;
  const reason = raw.reason;
  const message = raw.message;
  if (
    reason !== 'child_failed'
    && reason !== 'child_cancelled'
    && reason !== 'throughput_below_estimate'
    && reason !== 'step_over_blocked'
  ) {
    return undefined;
  }
  if (typeof message !== 'string' || message.trim().length === 0) return undefined;
  const signal: PlanDivergenceSignal = { reason, message: message.trim() };
  if (typeof raw.stepId === 'string' && raw.stepId.trim()) signal.stepId = raw.stepId.trim();
  if (typeof raw.childTaskId === 'string' && raw.childTaskId.trim()) {
    signal.childTaskId = raw.childTaskId.trim();
  }
  return signal;
}

/** Read planAdaptive state from persisted task progress JSON. */
export function readPlanAdaptiveState(progress: Record<string, unknown>): PlanAdaptiveState | null {
  const raw = progress[PROGRESS_KEY];
  if (!isPlainObject(raw)) return null;

  const planDepth = raw.planDepth;
  const replanCount = raw.replanCount;
  if (
    typeof planDepth !== 'number' || !Number.isInteger(planDepth) || planDepth < 1
    || typeof replanCount !== 'number' || !Number.isInteger(replanCount) || replanCount < 0
  ) {
    return null;
  }

  const pendingSignals: PlanDivergenceSignal[] = [];
  if (Array.isArray(raw.pendingSignals)) {
    for (const item of raw.pendingSignals) {
      const signal = parseSignal(item);
      if (signal) pendingSignals.push(signal);
    }
  }

  return { planDepth, replanCount, pendingSignals };
}

/** Merge planAdaptive state into a progress object (preserves sibling blocks). */
export function mergePlanAdaptiveState(
  progress: Record<string, unknown>,
  state: PlanAdaptiveState,
): Record<string, unknown> {
  return { ...progress, [PROGRESS_KEY]: state };
}

/** Resolve per-task adaptive ceilings — error_budget overrides win over config (#1266). */
export function resolvePlanAdaptiveCeilings(
  config: ResumableCeilingsConfig,
  errorBudget: Record<string, unknown>,
): Pick<
  ResumableCeilingsConfig,
  'maxPlanDepth' | 'maxReplansPerSubtree' | 'blockedStepHours' | 'throughputDivergenceRatio'
> {
  const pick = (
    key: 'maxPlanDepth' | 'maxReplansPerSubtree' | 'blockedStepHours' | 'throughputDivergenceRatio',
    budgetKey: string,
  ): number => {
    const override = errorBudget[budgetKey];
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return override;
    }
    return config[key];
  };
  return {
    maxPlanDepth: pick('maxPlanDepth', 'max_plan_depth'),
    maxReplansPerSubtree: pick('maxReplansPerSubtree', 'max_replans_per_subtree'),
    blockedStepHours: pick('blockedStepHours', 'blocked_step_hours'),
    throughputDivergenceRatio: pick('throughputDivergenceRatio', 'throughput_divergence_ratio'),
  };
}

export interface DetectPlanDivergenceInput {
  steps: readonly PlanStepDescriptor[];
  children: ReadonlyMap<string, Pick<TaskRow, 'id' | 'status' | 'updatedAt' | 'progress' | 'errorBudget' | 'title'>>;
  ceilings: ResumableCeilingsConfig;
  stepTitleById?: ReadonlyMap<string, string>;
  now?: Date;
}

function stepLabel(stepId: string, stepTitleById?: ReadonlyMap<string, string>): string {
  return stepTitleById?.get(stepId) ?? stepId;
}

function hoursBlocked(updatedAt: string, now: Date): number {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return 0;
  return Math.max((now.getTime() - updatedMs) / 3_600_000, 0);
}

function detectThroughputDivergence(
  child: Pick<TaskRow, 'id' | 'progress' | 'errorBudget' | 'title'>,
  stepId: string,
  ceilings: ResumableCeilingsConfig,
  stepTitleById?: ReadonlyMap<string, string>,
  now?: Date,
): PlanDivergenceSignal | null {
  const resumable = readResumableBlock(child.progress);
  if (!resumable || resumable.total <= resumable.done) return null;

  const circuit = readCircuitState(child.progress);
  const metrics = computeResumableThroughput(resumable, circuit, now);
  if (!metrics.estimateAvailable || metrics.unitsPerSlice === null || metrics.unitsPerSlice <= 0) {
    return null;
  }

  const adaptiveCeilings = resolvePlanAdaptiveCeilings(ceilings, child.errorBudget);
  const iterationBudget = resolveResumableIterationBudget(ceilings, child.errorBudget);
  const iterationsUsed = circuit?.iterationCount ?? 0;
  const remainingIterations = Math.max(iterationBudget - iterationsUsed, 1);
  const remainingUnits = Math.max(resumable.total - resumable.done, 0);
  const impliedUnitsPerSlice = remainingUnits / remainingIterations;

  if (impliedUnitsPerSlice <= 0) return null;
  const paceRatio = metrics.unitsPerSlice / impliedUnitsPerSlice;
  if (paceRatio >= adaptiveCeilings.throughputDivergenceRatio) return null;

  const label = child.title.trim() || stepLabel(stepId, stepTitleById);
  return {
    reason: 'throughput_below_estimate',
    stepId,
    childTaskId: child.id,
    message:
      `Child "${label}" throughput ~${metrics.unitsPerSlice.toFixed(1)} units/slice `
      + `vs ~${impliedUnitsPerSlice.toFixed(1)} needed to finish within the iteration budget `
      + `(ratio ${(paceRatio * 100).toFixed(0)}%, threshold ${(adaptiveCeilings.throughputDivergenceRatio * 100).toFixed(0)}%) `
      + '— consider re-planning slice size or approach.',
  };
}

function resolveResumableIterationBudget(
  ceilings: ResumableCeilingsConfig,
  errorBudget: Record<string, unknown>,
): number {
  const override = errorBudget.max_iterations;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override;
  }
  return ceilings.maxIterations;
}

/**
 * Detect plan divergence from live child rows. Returns advisory signals only —
 * a healthy plan with no triggers yields an empty array.
 */
export function detectPlanDivergence(input: DetectPlanDivergenceInput): PlanDivergenceSignal[] {
  const now = input.now ?? new Date();
  const adaptiveCeilings = resolvePlanAdaptiveCeilings(input.ceilings, {});
  const signals: PlanDivergenceSignal[] = [];
  const seen = new Set<string>();

  const push = (signal: PlanDivergenceSignal): void => {
    const key = `${signal.reason}:${signal.childTaskId ?? signal.stepId ?? signal.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push(signal);
  };

  for (const step of input.steps) {
    if (!step.taskId) continue;
    const child = input.children.get(step.taskId);
    if (!child) continue;

    const label = child.title.trim() || stepLabel(step.id, input.stepTitleById);

    if (child.status === 'failed') {
      push({
        reason: 'child_failed',
        stepId: step.id,
        childTaskId: child.id,
        message: `Child "${label}" failed — consider re-running plan to adjust dependencies or scope.`,
      });
      continue;
    }

    if (child.status === 'cancelled') {
      push({
        reason: 'child_cancelled',
        stepId: step.id,
        childTaskId: child.id,
        message: `Child "${label}" was cancelled — consider re-running plan if that was unexpected.`,
      });
      continue;
    }

    if (child.status === 'blocked') {
      const blockedHours = hoursBlocked(child.updatedAt, now);
      if (blockedHours >= adaptiveCeilings.blockedStepHours) {
        push({
          reason: 'step_over_blocked',
          stepId: step.id,
          childTaskId: child.id,
          message:
            `Step "${label}" has been blocked for ~${Math.round(blockedHours)}h `
            + `(threshold ${adaptiveCeilings.blockedStepHours}h) — consider re-planning around the blocker.`,
        });
      }
    }

    const throughputSignal = detectThroughputDivergence(
      child,
      step.id,
      input.ceilings,
      input.stepTitleById,
      now,
    );
    if (throughputSignal) push(throughputSignal);
  }

  return signals;
}

/** Resolve plan depth for a new or re-plan write. */
export function resolvePlanDepthForWrite(
  parent: Pick<TaskRow, 'parentTaskId' | 'progress'>,
  grandparent: Pick<TaskRow, 'progress'> | null,
  isReplan: boolean,
): number {
  const existing = readPlanAdaptiveState(parent.progress);
  if (isReplan && existing) return existing.planDepth;

  if (existing?.planDepth) return existing.planDepth;

  if (!parent.parentTaskId) return 1;

  const grandAdaptive = grandparent ? readPlanAdaptiveState(grandparent.progress) : null;
  const grandDepth = grandAdaptive?.planDepth ?? 1;
  return grandDepth + 1;
}

export function detectPlanAdaptiveBreach(
  state: Pick<PlanAdaptiveState, 'planDepth' | 'replanCount'>,
  ceilings: ResumableCeilingsConfig,
  errorBudget: Record<string, unknown> = {},
): PlanAdaptiveBreach | null {
  const adaptive = resolvePlanAdaptiveCeilings(ceilings, errorBudget);

  if (state.planDepth > adaptive.maxPlanDepth) {
    return {
      reason: 'max_plan_depth',
      planDepth: state.planDepth,
      replanCount: state.replanCount,
      message:
        `Plan decomposition depth ${state.planDepth} exceeds limit ${adaptive.maxPlanDepth} `
        + '— progressive planning cannot recurse further.',
    };
  }

  if (state.replanCount > adaptive.maxReplansPerSubtree) {
    return {
      reason: 'max_replans',
      planDepth: state.planDepth,
      replanCount: state.replanCount,
      message:
        `Re-plan count ${state.replanCount} exceeds limit ${adaptive.maxReplansPerSubtree} `
        + 'for this subtree — further re-decomposition is blocked.',
    };
  }

  return null;
}

/** Advisory divergence block injected into the planned-parent harness (#1266). */
export function buildPlanDivergenceGuidanceBlock(signals: readonly PlanDivergenceSignal[]): string | null {
  if (signals.length === 0) return null;

  const lines = [
    '### Plan divergence (advisory)',
    '',
    'Reality may have diverged from the current plan. Re-planning is **optional** — only call `plan` if you judge the decomposition needs adjustment:',
    '',
  ];

  for (const signal of signals) {
    lines.push(`- ${signal.message}`);
  }

  lines.push(
    '',
    'A healthy plan that is still on track needs no re-plan.',
  );

  return lines.join('\n');
}

export interface EscalatePlanAdaptiveBreachOptions {
  bus?: EventBus;
  taskRepo: TaskRepo;
  logger: Logger;
  task: TaskRow;
  breach: PlanAdaptiveBreach;
  agentId: string;
  circuitState?: ResumableCircuitState | null;
}

/**
 * Fail the planned task and surface a richer escalation to coordinator + CEO backlog.
 */
export async function escalatePlanAdaptiveBreach(opts: EscalatePlanAdaptiveBreachOptions): Promise<void> {
  const { task, breach, bus, taskRepo, logger, agentId } = opts;
  const progressNote = [
    breach.message,
    `Plan depth: ${breach.planDepth}, re-plans on this task: ${breach.replanCount}.`,
    'Progressive planning hit its adaptive depth/re-plan ceiling — human review required.',
  ].join(' ');

  const circuitState: ResumableCircuitState = opts.circuitState ?? readCircuitState(task.progress) ?? {
    stallCount: 0,
    iterationCount: 0,
    startedAt: new Date().toISOString(),
    totalCostUsd: 0,
    lastProgress: { done: 0, cursor: null },
  };

  const updated = await taskRepo.failResumableTask(task.id, {
    progressNote,
    circuitState,
    tags: ['needs-attention', 'plan-adaptive-breach', breach.reason],
  });

  if (!updated) {
    logger.warn({ taskId: task.id }, 'Plan adaptive breach escalation: task not found or already terminal');
    return;
  }

  if (!bus) {
    logger.warn({ taskId: task.id }, 'Plan adaptive breach: bus unavailable — CEO backlog only via fail path');
    return;
  }

  const notifyContent = [
    'A planned task hit its adaptive re-planning depth ceiling and needs attention.',
    '',
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Agent: ${agentId}`,
    `Reason: ${breach.reason}`,
    breach.message,
    '',
    `Plan depth: ${breach.planDepth} · Re-plans: ${breach.replanCount}`,
    '',
    'Do not re-delegate or schedule further plan decomposition for this task. Help the principal decide whether to simplify the goal, reset the subtree, or intervene manually.',
  ].join('\n');

  const notifyEvent = createAgentTask({
    agentId: 'coordinator',
    conversationId: `plan-adaptive:${task.id}`,
    channelId: 'scheduler',
    senderId: 'system',
    content: notifyContent,
    parentEventId: task.id,
  });
  try {
    await bus.publish('system', notifyEvent);
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'Failed to notify coordinator of plan adaptive breach');
  }

  try {
    await taskRepo.createTask({
      agentId: 'coordinator',
      title: `Review: plan depth limit (${task.title})`,
      description: [
        breach.message,
        '',
        `Task ID: ${task.id}`,
        `Specialist: ${task.sourceAgentId ?? agentId}`,
        `Plan depth: ${breach.planDepth}`,
        `Re-plans on this task: ${breach.replanCount}`,
        '',
        progressNote,
        '',
        'Suggested next steps: simplify the goal, cancel and restart the subtree, or manually unblock the stuck step.',
      ].join('\n'),
      owner: 'ceo',
      source: 'coordinator',
      tags: ['needs-attention', 'plan-adaptive-breach', breach.reason],
      parentTaskId: task.parentTaskId ?? undefined,
    });
    logger.info({ taskId: task.id, reason: breach.reason }, 'Escalated plan adaptive breach to CEO backlog');
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'Failed to create CEO backlog task for plan adaptive breach');
  }
}
