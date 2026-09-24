// delegation-guard.ts — per-task-turn guard against blind identical re-delegation (#1171).
//
// Tracks delegate(agent, task) attempts within a single coordinator task turn.
// Non-retryable specialist failures block further identical delegations; retryable
// failures allow a bounded number of attempts before blocking.

import type { AgentResponseFailureReason } from '../bus/events.js';
import { decodeResumeToken, resumeTokenOriginalTaskForm } from './resume-token.js';
import type { ExecutionLayer, InvokeOptions } from '../skills/execution.js';
import type { CallerContext } from '../skills/types.js';
import type { Logger } from '../logger.js';
import { buildDelegationEscalation, renderEscalation } from './task-escalation.js';

/** Total identical delegate calls allowed when the specialist failure was retryable. */
export const MAX_RETRYABLE_IDENTICAL_DELEGATIONS = 2;

/**
 * Guard reason seeded on a late-delivery wake (#1799): this agent+task already ran to completion
 * and its result is in the woken turn's task content.
 *
 * It is the one reason a `resume_token` cannot talk its way past. The resume exemption (#1171)
 * exists because a continuation carries new CEO direction, so it is not a repeat of the same
 * request — but "already delivered" is not a failure to continue from, it is finished work, and
 * resuming it would redo the side effects the delivery exists to avoid repeating.
 */
export const ALREADY_DELIVERED_REASON = 'already_delivered';

/**
 * Guard reason when a specialist already has an unresolved `pending_delegations` handle in the
 * originating conversation (#1858). Sibling of `already_delivered`: that one means the work
 * finished, this one means it is still running. Task prose is not part of the match — the
 * coordinator rewords the brief on every retry, which is how the identical-task guard missed it.
 */
export const ALREADY_IN_FLIGHT_REASON = 'already_in_flight';

export interface DelegationFailureInfo {
  agent: string;
  reason: AgentResponseFailureReason | string;
  retryable: boolean;
  message: string;
  /** Set when a delegate wait timed out but the specialist may still be running (#1288). */
  possiblySucceeded?: boolean;
  /** Timeout only (#1799): the delegate agent.task event id, which the still-running specialist
   *  will stamp as parentEventId on its late response. Carried through so the runtime can open a
   *  pending delegation handle instead of leaving that response unmatchable. */
  delegateEventId?: string;
  /** Timeout only (#1799): the conversation the abandoned specialist is running in. */
  delegateConversationId?: string;
  /** Timeout only (#1799): the delegate wait that elapsed, in ms. */
  waitTimeoutMs?: number;
  /** Set when the specialist refused via the structured decline marker (#1871). */
  declined?: boolean;
}

interface DelegationEntry {
  attempts: number;
  lastFailure?: DelegationFailureInfo;
  escalated: boolean;
}

export function delegationKey(agent: string, task: string): string {
  return `${agent}\0${task.trim()}`;
}

/** Agent name encoded by delegationKey, or '' when the key is not in that shape. */
export function agentFromDelegationKey(key: string): string {
  const idx = key.indexOf('\0');
  return idx === -1 ? '' : key.slice(0, idx);
}

export class DelegationGuard {
  private readonly entries = new Map<string, DelegationEntry>();
  /** Agent-scoped refusals (#1871). A reworded brief is a different key, so an
   *  identical-task block would not stop the retry loop a prose refusal caused. */
  private readonly agentDeclines = new Map<string, DelegationFailureInfo>();

  /** Whether another identical delegation may be invoked. */
  canAttempt(key: string): boolean {
    const agent = agentFromDelegationKey(key);
    if (agent !== '' && this.agentDeclines.has(agent)) return false;
    const entry = this.entries.get(key);
    if (!entry) return true;
    if (!entry.lastFailure) return true;
    if (entry.lastFailure.retryable === false) return false;
    return entry.attempts < MAX_RETRYABLE_IDENTICAL_DELEGATIONS;
  }

  /**
   * Record a structured specialist refusal. Further delegate calls to this agent
   * are blocked for the rest of the turn, including when the brief is reworded.
   */
  recordSpecialistDecline(agent: string, failure: DelegationFailureInfo): void {
    if (agent === '') return;
    this.agentDeclines.set(agent, failure);
  }

  /** The structured refusal recorded for this agent, if the turn already saw one. */
  getAgentDecline(agent: string): DelegationFailureInfo | undefined {
    return this.agentDeclines.get(agent);
  }

  /** Record an in-flight delegate invocation (before the specialist runs). */
  recordInvocation(key: string): void {
    const entry = this.entries.get(key) ?? { attempts: 0, escalated: false };
    entry.attempts += 1;
    this.entries.set(key, entry);
  }

  recordFailure(key: string, failure: DelegationFailureInfo): void {
    const entry = this.entries.get(key) ?? { attempts: 1, escalated: false };
    entry.lastFailure = failure;
    this.entries.set(key, entry);
  }

  shouldEscalate(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry?.lastFailure) return false;
    if (entry.escalated) return false;
    if (entry.lastFailure.retryable === false) return true;
    return entry.attempts >= MAX_RETRYABLE_IDENTICAL_DELEGATIONS;
  }

  markEscalated(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.escalated = true;
  }

  getFailure(key: string): DelegationFailureInfo | undefined {
    return this.entries.get(key)?.lastFailure;
  }

  isEscalated(key: string): boolean {
    return this.entries.get(key)?.escalated === true;
  }

  /** Whether this agent+task was recorded as already completed by a late delivery (#1799). */
  isAlreadyDelivered(key: string): boolean {
    return this.entries.get(key)?.lastFailure?.reason === ALREADY_DELIVERED_REASON;
  }
}

/**
 * The guard key carrying an `already_delivered` record for this delegate call, or undefined.
 *
 * Checking only `delegationKey(agent, task)` is not enough for a resume. A resume call's `task` is
 * the CEO's new DIRECTION — the original brief lives inside the token — so its key differs from the
 * one the late-delivery wake seeded, and the block would silently not apply to the shape a resume
 * normally takes. That is the whole bypass: different key, same work, specialist runs again.
 *
 * Shared by the runtime's pre-invoke gate and DelegateHandler so the two cannot drift: the handler
 * is what actually publishes the specialist task, and it validates only the token's agent.
 */
export function findAlreadyDeliveredKey(
  guard: DelegationGuard,
  agent: string,
  task: string,
  resumeToken?: string,
): string | undefined {
  const taskKey = delegationKey(agent, task);
  if (guard.isAlreadyDelivered(taskKey)) return taskKey;

  if (resumeToken === undefined || resumeToken === '') return undefined;
  // decodeResumeToken never throws — a malformed token yields null, and is handled later by the
  // handler's own validation. Here an undecodable token simply cannot prove anything.
  const payload = decodeResumeToken(resumeToken);
  if (!payload) return undefined;

  // A token minted for another specialist says nothing about THIS delegation. The handler rejects
  // the mismatch with a specific error a few lines later; letting the token's task decide the guard
  // key first would replace that error with a generic "blocked", which is both wrong and less
  // actionable.
  if (payload.agent !== agent) return undefined;

  const originalTask = payload.original_task;
  if (originalTask === '') return undefined;

  const originalKey = delegationKey(agent, originalTask);
  return guard.isAlreadyDelivered(originalKey) ? originalKey : undefined;
}

/**
 * Record an already-delivered verdict under every key a later delegate call could present (#1799).
 *
 * Two keys, because `encodeResumeToken` truncates an original task over MAX_RESUME_TASK_LENGTH: a
 * resume of a long brief carries the truncated form, whose key differs from the full brief's. The
 * `delegate` input puts no ceiling on task length, so a brief long enough to be truncated is
 * ordinary — and without this the block would silently not apply to it.
 */
export function seedAlreadyDelivered(
  guard: DelegationGuard,
  agent: string,
  task: string,
  message: string,
): void {
  const failure: DelegationFailureInfo = {
    agent,
    reason: ALREADY_DELIVERED_REASON,
    retryable: false,
    message,
  };
  guard.recordFailure(delegationKey(agent, task), failure);

  const tokenForm = resumeTokenOriginalTaskForm(task);
  if (tokenForm !== task) {
    guard.recordFailure(delegationKey(agent, tokenForm), failure);
  }
}

export interface DelegateFailureResult extends DelegationFailureInfo {
  failed: true;
  blocked?: boolean;
  escalated?: boolean;
}

/** A delegate result that refused to start because the specialist is already running (#1858, #1893). */
export function parseDelegateInFlightData(
  data: unknown,
  logger?: Logger,
): { agent: string; delegateEventId?: string } | null {
  if (data === null || data === undefined) return null;
  let record: Record<string, unknown>;
  if (typeof data === 'string') {
    try {
      record = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      logger?.warn(
        { err, dataPreview: data.slice(0, 200) },
        'Failed to parse delegate in-flight payload — treating as not in flight',
      );
      return null;
    }
  } else if (typeof data === 'object' && !Array.isArray(data)) {
    record = data as Record<string, unknown>;
  } else {
    return null;
  }
  if (record['in_flight'] !== true || record['reason'] !== ALREADY_IN_FLIGHT_REASON) return null;
  if (typeof record['agent'] !== 'string' || record['agent'] === '') return null;
  const delegateEventId = record['delegate_event_id'];
  return {
    agent: record['agent'],
    ...(typeof delegateEventId === 'string' && delegateEventId !== '' && { delegateEventId }),
  };
}

/** Parse a delegate skill success payload that carries structured failure fields. */
export function parseDelegateFailureData(data: unknown, logger?: Logger): DelegateFailureResult | null {
  if (data === null || data === undefined) return null;
  let record: Record<string, unknown>;
  if (typeof data === 'string') {
    try {
      record = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      logger?.warn(
        { err, dataPreview: data.slice(0, 200) },
        'Failed to parse delegate failure payload — treating as non-failure',
      );
      return null;
    }
  } else if (typeof data === 'object' && !Array.isArray(data)) {
    record = data as Record<string, unknown>;
  } else {
    return null;
  }
  if (record['failed'] !== true) return null;
  if (typeof record['agent'] !== 'string' || typeof record['retryable'] !== 'boolean') return null;
  if (typeof record['message'] !== 'string') return null;
  const reason = record['reason'];
  if (typeof reason !== 'string') return null;
  return {
    failed: true,
    agent: record['agent'],
    reason,
    retryable: record['retryable'],
    message: record['message'],
    ...(record['blocked'] === true && { blocked: true }),
    ...(record['escalated'] === true && { escalated: true }),
    ...(record['possibly_succeeded'] === true && { possiblySucceeded: true }),
    // #1799 correlation ids — present only on the timeout branch. Typed individually rather
    // than spread wholesale so a malformed payload cannot inject non-string ids.
    ...(typeof record['delegate_event_id'] === 'string' && {
      delegateEventId: record['delegate_event_id'],
    }),
    ...(typeof record['delegate_conversation_id'] === 'string' && {
      delegateConversationId: record['delegate_conversation_id'],
    }),
    ...(typeof record['wait_timeout_ms'] === 'number'
      && Number.isFinite(record['wait_timeout_ms'])
      && record['wait_timeout_ms'] > 0
      && { waitTimeoutMs: record['wait_timeout_ms'] }),
    ...(record['declined'] === true && { declined: true }),
  };
}

/** Outcome of an escalation attempt. `reviewTaskId` is present only when task-create both
 *  succeeded and returned a parseable id — #1799 links the pending delegation handle to that
 *  row so the late result can close or annotate it. */
export interface DelegationEscalationResult {
  escalated: boolean;
  reviewTaskId?: string;
}

/** Read the created task id out of a task-create result payload (string or object data). */
function parseCreatedTaskId(data: unknown, logger: Logger): string | undefined {
  let record: Record<string, unknown>;
  if (typeof data === 'string') {
    try {
      record = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      logger.warn({ err }, 'Could not parse task-create result — escalation review task id unavailable');
      return undefined;
    }
  } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    record = data as Record<string, unknown>;
  } else {
    return undefined;
  }
  const id = record['task_id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Surface a non-retryable delegation failure on the CEO backlog via task-create (#1171, #1267). */
export async function escalateDelegationFailure(
  executionLayer: ExecutionLayer,
  caller: CallerContext | undefined,
  options: InvokeOptions,
  failure: DelegationFailureInfo & { task: string },
  logger: Logger,
): Promise<DelegationEscalationResult> {
  // Structured, principal-facing payload (#1267): reason 'blocked' → blocked_on_human,
  // anything else → agent_incomplete. Rendered into the CEO task's progress note (the digest's
  // data source) + description, and stored as the structured progress.escalation block.
  const escalation = buildDelegationEscalation({
    agent: failure.agent,
    reason: String(failure.reason),
    retryable: failure.retryable,
    message: failure.message,
    task: failure.task,
    ...(failure.possiblySucceeded === true && { possiblySucceeded: true }),
  });
  const rendered = renderEscalation(escalation);
  const title = escalation.failureMode === 'blocked_on_human'
    ? `Review: ${failure.agent} is blocked on a person`
    : `Review: ${failure.agent} could not complete delegated work`;

  try {
    const result = await executionLayer.invoke(
      'task-create',
      {
        title,
        description: [
          rendered.description,
          '',
          'Original delegated task:',
          failure.task,
        ].join('\n'),
        owner: 'ceo',
        source: 'coordinator',
        // The failureMode tag distinguishes blocked-on-a-person from couldn't-finish (#1267).
        tags: ['delegation-failure', failure.agent, escalation.failureMode],
        progress_note: rendered.progressNote,
        escalation_json: JSON.stringify(escalation),
      },
      caller,
      options,
    );
    if (!result.success) {
      logger.error(
        { agent: failure.agent, reason: failure.reason, error: result.error },
        'Failed to escalate delegation failure to CEO backlog via task-create',
      );
      return { escalated: false };
    }
    const reviewTaskId = parseCreatedTaskId(result.data, logger);
    logger.info(
      { agent: failure.agent, reason: failure.reason, reviewTaskId },
      'Escalated delegation failure to CEO backlog via task-create',
    );
    return { escalated: true, ...(reviewTaskId !== undefined && { reviewTaskId }) };
  } catch (err) {
    logger.error(
      { err, agent: failure.agent, reason: failure.reason },
      'Unexpected error escalating delegation failure to CEO backlog',
    );
    return { escalated: false };
  }
}
