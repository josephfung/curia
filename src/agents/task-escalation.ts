// task-escalation.ts — structured, principal-facing escalation payloads (#1267).
//
// A stalled / ceiling-breached / blocked resumable, planned, or delegated task escalates
// today as a near-bare `needs-attention` principal backlog row: the detail lives in the task
// `description`, but the daily digest reads `last_progress_note`, so the principal sees
// only the title + tags. This module produces a structured `TaskEscalation` payload (stored
// at progress.escalation for audit / a future interactive surface) and a pure renderer that
// turns it into the principal task's progress note — the field the digest actually reads — plus the
// coordinator poke and the task description.
//
// Pure functions only — no I/O. The two escalation entry points
// (escalateCircuitBreach, escalateDelegationFailure) build a payload, render it, and seed it
// onto the created principal task. Failure modes map to what the platform actually produces; see
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
import { sanitizeOutput } from '../skills/sanitize.js';
import { isUuid } from '../util/uuid.js';

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

/** Structured escalation payload, stored at tasks.progress.escalation on the principal row. */
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
  /**
   * An outside sender left waiting by this failure (#1978): the delegation ran on their
   * inbound, so the reply they got said it could not be done yet. Recorded so the
   * principal's digest shows someone is waiting, and so that reply can promise a
   * follow-up that something tracks. Absent when no one outside is waiting.
   */
  awaitingReply?: EscalationRequester;
}

/**
 * The outside sender waiting on a reply. Built only by escalationRequester(), which
 * sanitizes and bounds the sender-supplied fields before they reach the digest.
 */
export interface EscalationRequester {
  /** Display name, or the address when the contact has none. */
  name: string;
  /** Channel identifier they wrote from (email address, phone number). */
  address: string;
  channel: string;
  /** contacts.id, only when the sender resolved to a contact. */
  contactId?: string;
  /** The conversation the reply belongs to, so the thread can be found again. */
  conversationId: string;
}

/** The three human-readable renderings derived from a payload. */
export interface RenderedEscalation {
  /** → the principal task's last progress note: the field the daily digest reads. */
  progressNote: string;
  /** → the coordinator `agent.task` poke. */
  notifyContent: string;
  /** → the principal task description (fuller detail for the task view). */
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
  /** Delegate wait timed out but the specialist may still be running (#1288). */
  possiblySucceeded?: boolean;
  /** The outside sender waiting on a reply, when the failure ran on their inbound (#1978). */
  awaitingReply?: EscalationRequester;
}

// Bounds for the sender-supplied fields. They land in the digest, so a name or
// address carrying a pasted essay must not take it over.
const MAX_REQUESTER_NAME = 120;
const MAX_REQUESTER_ADDRESS = 200;

// A UTF-16 surrogate with no partner. Postgres jsonb rejects one, so a single bad
// character would make task-create fail and the review task vanish.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Sanitize one sender-supplied field and fold it onto a single bounded line.
 * Bounded by code point, not UTF-16 unit, so the cut never splits an emoji; any
 * lone surrogate already in the input is replaced for the same reason.
 */
function requesterField(raw: string, max: number): string {
  const folded = sanitizeOutput(raw).replace(LONE_SURROGATE, '\uFFFD').replace(/\s+/g, ' ').trim();
  return Array.from(folded).slice(0, max).join('').trim();
}

/**
 * Build the waiting-sender record from the turn's sender (#1978). The name and
 * address come from outside (self-claimed names, raw channel ids), so both are
 * sanitized, folded onto one line and bounded. A contact id is kept only when it
 * is a real contacts UUID; unresolved senders carry their raw address there.
 */
export function escalationRequester(input: {
  displayName?: string;
  contactId?: string;
  senderId: string;
  channel: string;
  conversationId: string;
}): EscalationRequester {
  const address = requesterField(input.senderId, MAX_REQUESTER_ADDRESS);
  const name = input.displayName !== undefined ? requesterField(input.displayName, MAX_REQUESTER_NAME) : '';
  return {
    name: name.length > 0 ? name : address,
    address,
    channel: input.channel,
    ...(isUuid(input.contactId) && { contactId: input.contactId.toLowerCase() }),
    conversationId: input.conversationId,
  };
}

/** "Lena Okafor (lena@example.test, email)", or "lena@example.test (email)" with no name. */
function describeRequester(r: EscalationRequester): string {
  return r.name === r.address ? `${r.name} (${r.channel})` : `${r.name} (${r.address}, ${r.channel})`;
}

/** The digest line for a waiting sender: "Lena Okafor (lena@example.test, email) is waiting on a reply." */
export function awaitingReplyLine(r: EscalationRequester): string {
  return `${describeRequester(r)} is waiting on a reply.`;
}

/**
 * The waiting sender stored on a review task (progress.escalation.awaitingReply), or
 * undefined. Read back by later writers of the progress note, which the digest shows
 * alone, so they can keep the waiting line in it (#1978).
 */
export function readAwaitingReply(progress: Record<string, unknown> | null | undefined): EscalationRequester | undefined {
  const escalation = progress?.['escalation'];
  if (!escalation || typeof escalation !== 'object' || Array.isArray(escalation)) return undefined;
  const raw = (escalation as Record<string, unknown>)['awaitingReply'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r['name'] !== 'string' || typeof r['address'] !== 'string'
    || typeof r['channel'] !== 'string' || typeof r['conversationId'] !== 'string') {
    return undefined;
  }
  return {
    name: r['name'],
    address: r['address'],
    channel: r['channel'],
    ...(typeof r['contactId'] === 'string' && { contactId: r['contactId'] }),
    conversationId: r['conversationId'],
  };
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
    : input.reason === 'timeout' && input.possiblySucceeded
      ? input.message
      : `${input.agent} could not finish the delegated work (${input.reason}).`;

  const suggested = input.reason === 'timeout' && input.possiblySucceeded
    ? [
      'The specialist may still be running — check whether it already delivered before taking further action.',
      'Do not re-delegate the same work; the original run may still be in flight.',
    ]
    : suggestedActions(failureMode, input.reason, { agent: input.agent });
  // Someone outside is waiting: replying to them comes first. They were told it could
  // not be done yet and that it would be followed up (#1978).
  const actions = input.awaitingReply
    ? [
      `Reply to ${input.awaitingReply.name} once this is sorted: they were told it could not be done yet and that it would be followed up.`,
      ...suggested,
    ]
    : suggested;

  return {
    failureMode,
    reason: input.reason,
    source: 'delegation',
    headline,
    // The agent is the "blocker" for an incomplete; a human-block has no structured "who".
    blocker: failureMode === 'agent_incomplete' ? input.agent : undefined,
    suggestedActions: actions,
    ...(input.awaitingReply && { awaitingReply: input.awaitingReply }),
  };
}

/**
 * Render a payload into the three principal-facing surfaces. The progress note is the digest
 * carrier (kept compact, single block); the coordinator poke and description carry the same
 * facts with the no-blind-retry instruction.
 */
export function renderEscalation(e: TaskEscalation): RenderedEscalation {
  const noteParts: string[] = [e.headline];
  // Right after the headline: the digest's one line should say a person is waiting.
  if (e.awaitingReply) noteParts.push(awaitingReplyLine(e.awaitingReply));
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
  if (e.awaitingReply) {
    detailLines.push(
      `Waiting on a reply: ${describeRequester(e.awaitingReply)}, conversation ${e.awaitingReply.conversationId}.`,
    );
  }
  detailLines.push('', 'Suggested next steps:', ...e.suggestedActions.map((a) => `- ${a}`));

  const description = detailLines.join('\n');

  const notifyContent = [
    ...detailLines,
    '',
    'Do not re-delegate or schedule continuations for this task. Let the principal know and help them decide next steps.',
  ].join('\n');

  return { progressNote, notifyContent, description };
}
