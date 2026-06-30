// task-escalation.ts — structured, principal-facing escalation payloads (#1267).
//
// A stalled / ceiling-breached / blocked resumable, planned, or delegated task escalates
// today as a near-bare `needs-attention` CEO backlog row: the detail lives in the task
// `description`, but the daily digest reads `last_progress_note`, so the principal sees
// only the title + tags. This module produces a structured `TaskEscalation` payload (stored
// at progress.escalation for audit / a future interactive surface) and a pure renderer that
// turns it into the CEO task's progress note — the field the digest actually reads — plus the
// coordinator poke and the task description.
//
// Pure functions only — no I/O. The two escalation entry points
// (escalateCircuitBreach, escalateDelegationFailure) build a payload, render it, and seed it
// onto the created CEO task. Failure modes map to what the platform actually produces; see
// the mapping table below. `needs_decision` is reserved but unwired — nothing emits it yet.

import type { CircuitBreach, CircuitBreachReason } from './resumable-circuit-breaker.js';
import type { ResumableThroughputMetrics } from './resumable-throughput.js';
import {
  computeResumableThroughput,
  formatResumableThroughputForResume,
} from './resumable-throughput.js';
import type { TaskRow } from '../db/queries/tasks.js';
import { readResumableBlock } from '../db/resumable-progress.js';
import { readPlanBlock } from '../db/plan-progress.js';

/**
 * Principal-facing failure categories (#1267). Mapped from real producers:
 *   - `stalled`          ← circuit breaker, reason `stall_limit`
 *   - `ceiling`          ← circuit breaker, reason `max_cost` / `max_wallclock` / `max_iterations`
 *   - `blocked_on_human` ← delegation guard, reason `blocked`
 *   - `agent_incomplete` ← delegation guard, any other non-retryable reason (`maxTurns`, `api_error`, …)
 * `needs_decision` is reserved as a category but never emitted — no producer exists yet.
 */
export type EscalationFailureMode =
  | 'stalled'
  | 'ceiling'
  | 'blocked_on_human'
  | 'agent_incomplete'
  | 'needs_decision';

export type EscalationSource = 'resumable_leaf' | 'planned_parent' | 'delegation';

export interface EscalationProgress {
  /** Units (resumable) or steps (plan) resolved so far. */
  done: number;
  /** Target unit / step count. */
  total: number;
}

/** Structured escalation payload, stored at tasks.progress.escalation on the CEO row. */
export interface TaskEscalation {
  failureMode: EscalationFailureMode;
  /** The specific producer sub-reason: 'stall_limit' | 'max_cost' | 'maxTurns' | 'blocked' | … */
  reason: string;
  source: EscalationSource;
  /** One-line, principal-facing summary of what went wrong. */
  headline: string;
  /** X-of-Y progress; absent for delegation failures (no progress tracked). */
  progress?: EscalationProgress;
  /** Rolling pace + ETA (#1264); resumable leaves only, when an estimate is available. */
  throughput?: ResumableThroughputMetrics;
  /** What's holding it up: the ceiling hit, the person waited on, or the agent that failed. */
  blocker?: string;
  /** Aggregate LLM cost across slices so far (circuit breaches). */
  costUsd?: number;
  /** Templated next-action options for the principal (resume / raise ceiling / cancel / re-scope). */
  suggestedActions: string[];
}

/** The three human-readable renderings derived from a payload. */
export interface RenderedEscalation {
  /** → the CEO task's last progress note: the field the daily digest reads. */
  progressNote: string;
  /** → the coordinator `agent.task` poke. */
  notifyContent: string;
  /** → the CEO task description (fuller detail for the task view). */
  description: string;
}

/** Delegation-failure shape consumed by the delegation escalation builder. */
export interface DelegationEscalationInput {
  agent: string;
  reason: string;
  retryable: boolean;
  message: string;
  /** The original delegated task text. */
  task: string;
}

function ceilingFailureMode(reason: CircuitBreachReason): EscalationFailureMode {
  return reason === 'stall_limit' ? 'stalled' : 'ceiling';
}

function formatProgress(p: EscalationProgress): string {
  return p.total > 0 ? `${p.done} of ${p.total}` : `${p.done} done`;
}

/** Templated next-action options keyed by failure mode (and the ceiling sub-reason). */
function suggestedActions(
  mode: EscalationFailureMode,
  reason: string,
  ctx: { agent?: string },
): string[] {
  switch (mode) {
    case 'stalled':
      return [
        'No forward progress across the last slices — the approach likely will not converge.',
        'Cancel it, or change the approach and re-delegate.',
      ];
    case 'ceiling': {
      const knob =
        reason === 'max_cost' ? 'error_budget.max_cost_usd'
          : reason === 'max_wallclock' ? 'error_budget.max_wallclock_hours'
            : 'error_budget.max_iterations';
      return [
        `Raise the ceiling (${knob}) and resume if the work is still worth it, or cancel.`,
      ];
    }
    case 'blocked_on_human':
      return [
        'Answer the open question or nudge the person it is waiting on, then let it resume.',
        'Or cancel if it is no longer needed.',
      ];
    case 'agent_incomplete':
      return [
        `${ctx.agent ?? 'The specialist'} could not finish as scoped.`,
        'Re-scope it smaller, hand it to a different agent, or cancel.',
      ];
    case 'needs_decision':
      return ['Make the call, then let it resume.'];
  }
}

/**
 * Build an escalation payload from a circuit-breaker breach. Detects whether the task is a
 * resumable leaf (progress.resumable) or a planned parent (progress.plan) and shapes the
 * payload accordingly: leaves carry throughput + ETA; planned parents carry an X-of-Y step
 * rollup with no per-unit throughput.
 */
export function buildCircuitBreachEscalation(
  task: TaskRow,
  breach: CircuitBreach,
  now: Date = new Date(),
): TaskEscalation {
  const failureMode = ceilingFailureMode(breach.reason);
  const plan = readPlanBlock(task.progress);
  const resumable = plan ? null : readResumableBlock(task.progress);
  const source: EscalationSource = plan ? 'planned_parent' : 'resumable_leaf';

  const progress: EscalationProgress = plan
    ? { done: plan.done, total: plan.total }
    : {
      done: resumable?.done ?? breach.state.lastProgress.done,
      total: resumable?.total ?? 0,
    };

  // Throughput is a resumable-leaf concept (units/slice, cost/unit, ETA). Planned parents
  // advance by child completions, not units, so they carry the X-of-Y rollup only.
  let throughput: ResumableThroughputMetrics | undefined;
  if (resumable) {
    const metrics = computeResumableThroughput(
      { done: resumable.done, total: resumable.total, lastSliceUnits: resumable.lastSliceUnits },
      breach.state,
      now,
    );
    if (metrics.estimateAvailable) throughput = metrics;
  }

  const headline = circuitHeadline(failureMode, breach, source);

  return {
    failureMode,
    reason: breach.reason,
    source,
    headline,
    progress,
    throughput,
    blocker: circuitBlocker(breach),
    costUsd: breach.state.totalCostUsd,
    suggestedActions: suggestedActions(failureMode, breach.reason, {}),
  };
}

// The headline names the failure type only. Progress (X of Y) and cost ($) are NOT restated
// here — renderEscalation's dedicated `Progress:` / `Cost so far:` lines are the single source
// of truth for those numbers (#1267, avoids stating them twice in the principal-facing text).
function circuitHeadline(
  mode: EscalationFailureMode,
  breach: CircuitBreach,
  source: EscalationSource,
): string {
  const what = source === 'planned_parent' ? 'the plan' : 'the task';
  if (mode === 'stalled') {
    const unit = source === 'planned_parent' ? 'wake' : 'slice';
    return `Stalled: ${what} made no forward progress for ${breach.state.stallCount} ${unit}(s).`;
  }
  switch (breach.reason) {
    case 'max_cost':
      return 'Hit the cost ceiling.';
    case 'max_wallclock':
      return 'Hit the time ceiling.';
    case 'max_iterations':
      return `Hit the slice ceiling (${breach.state.iterationCount} continuations).`;
    default:
      return `${what} breached a ceiling.`;
  }
}

// Non-numeric constraint descriptor for the structured `blocker` field. Deliberately carries no
// dollar / count — those live on the dedicated render lines, so the "Blocked by:" line never
// repeats a figure already stated above it (#1267).
function circuitBlocker(breach: CircuitBreach): string | undefined {
  switch (breach.reason) {
    case 'max_cost':
      return 'the cost ceiling';
    case 'max_wallclock':
      return 'the wallclock ceiling';
    case 'max_iterations':
      return 'the iteration ceiling';
    default:
      return undefined;
  }
}

/**
 * Build an escalation payload from a non-retryable delegation failure. A `blocked` reason
 * means the specialist is waiting on a human (blocked_on_human); any other reason means it
 * could not finish the work as scoped (agent_incomplete). No progress / throughput — a
 * delegation failure is a single attempt, not a tracked sweep.
 */
export function buildDelegationEscalation(input: DelegationEscalationInput): TaskEscalation {
  const failureMode: EscalationFailureMode =
    input.reason === 'blocked' ? 'blocked_on_human' : 'agent_incomplete';

  const headline = failureMode === 'blocked_on_human'
    ? `Blocked on a person: ${input.agent} cannot proceed without input — ${input.message}`
    : `${input.agent} could not finish the delegated work (${input.reason}).`;

  return {
    failureMode,
    reason: input.reason,
    source: 'delegation',
    headline,
    // The agent is the "blocker" for an incomplete; a human-block has no structured "who".
    blocker: failureMode === 'agent_incomplete' ? input.agent : undefined,
    suggestedActions: suggestedActions(failureMode, input.reason, { agent: input.agent }),
  };
}

/**
 * Render a payload into the three principal-facing surfaces. The progress note is the digest
 * carrier (kept compact, single block); the coordinator poke and description carry the same
 * facts with the no-blind-retry instruction.
 */
export function renderEscalation(e: TaskEscalation): RenderedEscalation {
  const noteParts: string[] = [e.headline];
  if (e.progress) noteParts.push(`Progress: ${formatProgress(e.progress)}.`);
  if (e.throughput?.estimateAvailable) noteParts.push(formatResumableThroughputForResume(e.throughput));
  if (typeof e.costUsd === 'number' && e.costUsd > 0) noteParts.push(`Cost so far: $${e.costUsd.toFixed(2)}.`);
  if (e.suggestedActions.length > 0) noteParts.push(`Suggested: ${e.suggestedActions.join(' ')}`);
  const progressNote = noteParts.join(' ');

  const detailLines: string[] = [e.headline, ''];
  if (e.progress) detailLines.push(`Progress: ${formatProgress(e.progress)}.`);
  if (e.throughput?.estimateAvailable) detailLines.push(formatResumableThroughputForResume(e.throughput));
  if (typeof e.costUsd === 'number' && e.costUsd > 0) detailLines.push(`Cost so far: $${e.costUsd.toFixed(2)}.`);
  if (e.blocker) detailLines.push(`Blocked by: ${e.blocker}.`);
  detailLines.push('', 'Suggested next steps:', ...e.suggestedActions.map((a) => `- ${a}`));

  const description = detailLines.join('\n');

  const notifyContent = [
    ...detailLines,
    '',
    'Do not re-delegate or schedule continuations for this task. Let the principal know and help them decide next steps.',
  ].join('\n');

  return { progressNote, notifyContent, description };
}
