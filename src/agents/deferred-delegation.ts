// deferred-delegation.ts — keep a brief that never started a specialist (#1893).
//
// Three paths return without dispatching: the pre-timeout claim conflict, the
// post-timeout already_in_flight refusal, and the same-turn escalation skip.
// Each one creates a backlog task that wakes itself. A timeout did dispatch —
// late delivery already wakes that result — so it must not be queued again.

import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { TaskOriginator } from '../contacts/types.js';
import { DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS } from './delegate-timeout.js';
import { computeLateDeliveryExpiry } from './late-delegation.js';

/** How many times one busy specialist may re-queue the same chain. */
export const MAX_DEFERRED_DELEGATION_ATTEMPTS = 3;

/**
 * Retry delay when a brief never started and neither config nor a resolved
 * wait is available. Matches the handler's fallback
 * (`DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS`): a shorter delay would wake the retry
 * before that wait expires (#1893). A deployment override of
 * `delegate.defaultTimeoutMs` is applied by the runtime; this constant is not
 * that override.
 */
export const DEFAULT_DEFERRED_WAKE_MS = DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS;

/**
 * How long to wait before retrying a brief that a `pending` handle blocked.
 *
 * The handle stays until `expires_at`, and the sweep closes it on the following
 * tick, so the delay is the time left plus one sweep interval. A timeout that
 * has not written the row yet passes no `expiresAt`: the expiry is the one
 * `LateDelegationSubscriber` will store (`max(ttl, 2 × wait)`). `created_at`
 * is not a clock for this — a promoted row keeps the dispatch time, so
 * ttl minus age wakes while the handle is still open.
 */
export function pendingHandleWakeDelayMs(params: {
  now: number;
  expiresAt?: Date;
  ttlMinutes: number;
  waitTimeoutMs?: number;
  sweepIntervalMs: number;
}): number {
  const sweep = Number.isFinite(params.sweepIntervalMs) && params.sweepIntervalMs > 0
    ? params.sweepIntervalMs
    : 0;
  const expiresAt = params.expiresAt !== undefined && !Number.isNaN(params.expiresAt.getTime())
    ? params.expiresAt
    : computeLateDeliveryExpiry(new Date(params.now), params.ttlMinutes, params.waitTimeoutMs);
  return Math.max(0, expiresAt.getTime() - params.now) + sweep;
}

export interface DelegationRetryWake {
  conversationId: string;
  channelId: string;
  senderId: string;
  targetAgent: string;
  brief: string;
  /** 1-based. Attempt 1 is the first time the brief was queued. */
  attempt: number;
}

export function delegationRetryWakePayload(wake: DelegationRetryWake): Record<string, unknown> {
  return { type: 'task-wake', delegationRetry: wake };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The routing envelope on a task-wake payload, or undefined when this wake is ordinary. */
export function readDelegationRetryWake(payload: unknown): DelegationRetryWake | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = (payload as Record<string, unknown>)['delegationRetry'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const attempt = record['attempt'];
  if (
    !isNonEmptyString(record['conversationId'])
    || !isNonEmptyString(record['channelId'])
    || !isNonEmptyString(record['senderId'])
    || !isNonEmptyString(record['targetAgent'])
    || !isNonEmptyString(record['brief'])
    || typeof attempt !== 'number'
    || !Number.isInteger(attempt)
    || attempt < 1
  ) {
    return undefined;
  }
  return {
    conversationId: record['conversationId'],
    channelId: record['channelId'],
    senderId: record['senderId'],
    targetAgent: record['targetAgent'],
    brief: record['brief'],
    attempt,
  };
}

/** What the woken coordinator reads. The brief is the task body, not a new conversation. */
export function formatDelegationRetryWakeContent(wake: DelegationRetryWake): string {
  return [
    'A specialist was already working in this conversation, so this request was queued instead of dropped.',
    'Delegate it now, to the specialist named below, using the brief as given.',
    'If delegate reports that specialist is still in flight, tell the user the request is queued. Do not start another run.',
    '',
    `Specialist: ${wake.targetAgent}`,
    '',
    wake.brief,
  ].join('\n');
}

/**
 * Attempt already recorded on this turn's task, or 0 when the turn is not a retry wake.
 * The counter travels on metadata so a reworded brief cannot reset it.
 */
export function readDelegationRetryAttempt(
  metadata: Record<string, unknown> | undefined,
): { attempt: number; targetAgent: string | undefined } {
  if (!metadata) return { attempt: 0, targetAgent: undefined };
  const raw = metadata['delegationRetry'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { attempt: 0, targetAgent: undefined };
  }
  const record = raw as Record<string, unknown>;
  const attempt = record['attempt'];
  const targetAgent = isNonEmptyString(record['targetAgent']) ? record['targetAgent'] : undefined;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    return { attempt: 0, targetAgent };
  }
  return { attempt, targetAgent };
}

export interface EnqueueUndispatchedDelegationParams {
  taskRepo: TaskRepo | undefined;
  logger: Logger;
  originAgentId: string;
  originConversationId: string;
  originChannelId: string;
  originSenderId: string;
  targetAgent: string;
  brief: string;
  wakeAt: Date;
  originator?: TaskOriginator;
  /** 1-based. Values above the cap are not written. */
  attempt: number;
}

export type EnqueueUndispatchedResult = 'enqueued' | 'capped' | 'unavailable';

/**
 * Persist a brief that did not dispatch. The linked one-shot job wakes the
 * originating agent in the originating conversation — not a scheduler thread.
 */
export async function enqueueUndispatchedDelegation(
  params: EnqueueUndispatchedDelegationParams,
): Promise<EnqueueUndispatchedResult> {
  const {
    taskRepo,
    logger,
    originAgentId,
    originConversationId,
    originChannelId,
    originSenderId,
    targetAgent,
    brief,
    wakeAt,
    originator,
    attempt,
  } = params;

  if (attempt > MAX_DEFERRED_DELEGATION_ATTEMPTS) {
    logger.warn(
      { targetAgent, originConversationId, attempt, cap: MAX_DEFERRED_DELEGATION_ATTEMPTS },
      'Deferred delegation retry cap reached — not queueing another wake',
    );
    return 'capped';
  }
  if (!taskRepo) {
    logger.error(
      { targetAgent, originConversationId },
      'Cannot queue an undispatched delegation — no task repo on this runtime',
    );
    return 'unavailable';
  }
  if (
    brief === ''
    || targetAgent === ''
    || originConversationId === ''
    || originChannelId === ''
    || originSenderId === ''
  ) {
    logger.error(
      {
        targetAgent,
        originConversationId,
        originChannelId,
        hasSender: originSenderId !== '',
        briefLength: brief.length,
      },
      'Cannot queue an undispatched delegation — missing agent, brief, conversation, channel, or sender',
    );
    return 'unavailable';
  }

  const wake: DelegationRetryWake = {
    conversationId: originConversationId,
    channelId: originChannelId,
    senderId: originSenderId,
    targetAgent,
    brief,
    attempt,
  };
  const task = await taskRepo.createTask({
    agentId: originAgentId,
    title: `Retry delegation to ${targetAgent}`,
    description: brief,
    source: 'coordinator',
    sourceAgentId: originAgentId,
    createdBy: originAgentId,
    tags: ['delegation-retry', targetAgent],
    wakeAt,
    wakePayload: delegationRetryWakePayload(wake),
    ...(originator !== undefined && { originator }),
    progressNote: `Queued while ${targetAgent} was already working in this conversation.`,
  });
  logger.info(
    {
      taskId: task.id,
      targetAgent,
      originConversationId,
      attempt,
      wakeAt: wakeAt.toISOString(),
    },
    'Queued an undispatched delegation for a later wake',
  );
  return 'enqueued';
}
