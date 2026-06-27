// delegation-guard.ts — per-task-turn guard against blind identical re-delegation (#1171).
//
// Tracks delegate(agent, task) attempts within a single coordinator task turn.
// Non-retryable specialist failures block further identical delegations; retryable
// failures allow a bounded number of attempts before blocking.

import type { AgentResponseFailureReason } from '../bus/events.js';
import type { ExecutionLayer, InvokeOptions } from '../skills/execution.js';
import type { CallerContext } from '../skills/types.js';
import type { Logger } from '../logger.js';

/** Total identical delegate calls allowed when the specialist failure was retryable. */
export const MAX_RETRYABLE_IDENTICAL_DELEGATIONS = 2;

export interface DelegationFailureInfo {
  agent: string;
  reason: AgentResponseFailureReason | string;
  retryable: boolean;
  message: string;
}

interface DelegationEntry {
  attempts: number;
  lastFailure?: DelegationFailureInfo;
  escalated: boolean;
}

export function delegationKey(agent: string, task: string): string {
  return `${agent}\0${task.trim()}`;
}

export class DelegationGuard {
  private readonly entries = new Map<string, DelegationEntry>();

  /** Whether another identical delegation may be invoked. */
  canAttempt(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    if (!entry.lastFailure) return true;
    if (entry.lastFailure.retryable === false) return false;
    return entry.attempts < MAX_RETRYABLE_IDENTICAL_DELEGATIONS;
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
}

export interface DelegateFailureResult extends DelegationFailureInfo {
  failed: true;
  blocked?: boolean;
  escalated?: boolean;
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
  };
}

/** Surface a non-retryable delegation failure on the CEO backlog via task-create (#1171). */
export async function escalateDelegationFailure(
  executionLayer: ExecutionLayer,
  caller: CallerContext | undefined,
  options: InvokeOptions,
  failure: DelegationFailureInfo & { task: string },
  logger: Logger,
): Promise<boolean> {
  try {
    const result = await executionLayer.invoke(
      'task-create',
      {
        title: `Review: ${failure.agent} could not complete delegated work`,
        description: [
          failure.message,
          '',
          `Reason: ${failure.reason}`,
          '',
          'Original delegated task:',
          failure.task,
        ].join('\n'),
        owner: 'ceo',
        source: 'coordinator',
        tags: ['delegation-failure', failure.agent],
      },
      caller,
      options,
    );
    if (!result.success) {
      logger.error(
        { agent: failure.agent, reason: failure.reason, error: result.error },
        'Failed to escalate delegation failure to CEO backlog via task-create',
      );
      return false;
    }
    logger.info(
      { agent: failure.agent, reason: failure.reason },
      'Escalated delegation failure to CEO backlog via task-create',
    );
    return true;
  } catch (err) {
    logger.error(
      { err, agent: failure.agent, reason: failure.reason },
      'Unexpected error escalating delegation failure to CEO backlog',
    );
    return false;
  }
}
