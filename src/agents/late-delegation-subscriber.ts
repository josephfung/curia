// late-delegation-subscriber.ts — opens a durable handle when a delegate wait times out, and
// matches the specialist's late agent.response back to it (#1799).
//
// System-layer, wired alongside ResumableContinuationSubscriber. Two subscriptions:
//
//   delegation.timed_out  → persist the handle (the runtime stays database-free, spec 06 L3)
//   agent.response        → if it answers an open handle, classify and resolve it
//
// The agent.response path does one indexed point lookup per response rather than keeping an
// in-memory index of open handles. At this platform's response volume the lookup is free, and
// it is immune to the staleness bug an index would have: the sweep also resolves handles, so a
// cached set could answer "open" for something already closed.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { AgentResponseEvent, DelegationTimedOutEvent } from '../bus/events.js';
import {
  getPendingDelegationByDelegateEventId,
  recordPendingDelegation,
} from '../db/queries/pending-delegations.js';
import {
  computeLateDeliveryExpiry,
  handleLateResponse,
  parseSchedulerJobId,
} from './late-delegation.js';

/** Postgres error codes that mean the review task reference — not the handle — is the problem:
 *  foreign_key_violation (the row is gone) and invalid_text_representation (not a UUID). */
const REVIEW_TASK_REFERENCE_ERRORS = new Set(['23503', '22P02']);

function pgErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

export interface LateDelegationSubscriberOptions {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  taskRepo: TaskRepo;
  /** How long a handle stays open before the sweep abandons it. */
  ttlMinutes: number;
  /** Cap on how much of a late result is copied into the review task's progress note. */
  maxResultChars: number;
  /** IANA timezone for principal-facing timestamps. */
  timezone?: string;
}

export class LateDelegationSubscriber {
  constructor(private readonly opts: LateDelegationSubscriberOptions) {}

  start(): void {
    this.opts.bus.subscribe('delegation.timed_out', 'system', async (event) => {
      await this.handleTimedOut(event as DelegationTimedOutEvent);
    });

    this.opts.bus.subscribe('agent.response', 'system', async (event) => {
      await this.handleResponse(event as AgentResponseEvent);
    });

    this.opts.logger.info(
      { ttlMinutes: this.opts.ttlMinutes, maxResultChars: this.opts.maxResultChars },
      'LateDelegationSubscriber started',
    );
  }

  /** Persist the handle for a delegation whose wait just gave up. */
  private async handleTimedOut(event: DelegationTimedOutEvent): Promise<void> {
    const p = event.payload;
    const expiresAt = computeLateDeliveryExpiry(
      new Date(),
      this.opts.ttlMinutes,
      p.waitTimeoutMs,
    );
    const schedulerJobId = parseSchedulerJobId(p.conversationId);

    const params = {
      delegateEventId: p.delegateEventId,
      delegateConversationId: p.delegateConversationId,
      targetAgent: p.targetAgent,
      delegateTask: p.delegateTask,
      originAgentId: p.agentId,
      originConversationId: p.conversationId,
      originChannelId: p.channelId,
      originSenderId: p.senderId,
      ...(p.originTaskEventId !== undefined && { originTaskEventId: p.originTaskEventId }),
      ...(p.originator !== undefined && { originator: p.originator }),
      ...(schedulerJobId !== undefined && { schedulerJobId }),
      expiresAt,
    };

    try {
      const { row, created } = await this.recordHandle(params, p.reviewTaskId);

      if (!created) {
        this.opts.logger.info(
          { delegateEventId: p.delegateEventId, status: row.status },
          'Late delegation: handle already existed for this delegation — not opening a second one',
        );
        return;
      }

      this.opts.logger.info(
        {
          delegateEventId: p.delegateEventId,
          targetAgent: p.targetAgent,
          originAgentId: p.agentId,
          originConversationId: p.conversationId,
          schedulerJobId,
          reviewTaskId: p.reviewTaskId,
          expiresAt: expiresAt.toISOString(),
        },
        'Late delegation: opened pending handle for a timed-out delegation',
      );
    } catch (err) {
      // The bus isolates subscriber errors, so throwing does not punish the publisher — but it
      // must not be swallowed either: without a handle the late response is orphaned, which is
      // the exact failure this mechanism exists to end.
      this.opts.logger.error(
        { err, delegateEventId: p.delegateEventId, targetAgent: p.targetAgent },
        'Late delegation: failed to open the pending handle',
      );
      throw err;
    }
  }

  /**
   * Insert the handle, falling back to one without the review-task link when that reference is
   * unusable. The handle matters more than the link: losing it over a deleted task (or a
   * non-UUID id) would orphan the late response, which is the failure this mechanism exists to
   * end. Resolution then records the outcome with no review row to annotate.
   */
  private async recordHandle(
    params: Parameters<typeof recordPendingDelegation>[1],
    reviewTaskId: string | undefined,
  ): Promise<{ row: Awaited<ReturnType<typeof recordPendingDelegation>>['row']; created: boolean }> {
    if (reviewTaskId === undefined) {
      return recordPendingDelegation(this.opts.pool, params);
    }
    try {
      return await recordPendingDelegation(this.opts.pool, { ...params, reviewTaskId });
    } catch (err) {
      if (!REVIEW_TASK_REFERENCE_ERRORS.has(pgErrorCode(err) ?? '')) throw err;
      this.opts.logger.warn(
        { err, delegateEventId: params.delegateEventId, reviewTaskId },
        'Late delegation: review task reference is unusable — opening the handle without it',
      );
      return recordPendingDelegation(this.opts.pool, params);
    }
  }

  /** Resolve an open handle when the abandoned specialist finally responds. */
  private async handleResponse(event: AgentResponseEvent): Promise<void> {
    const delegateEventId = event.parentEventId;
    if (!delegateEventId) return;

    try {
      const handle = await getPendingDelegationByDelegateEventId(this.opts.pool, delegateEventId);
      if (!handle) return;
      if (handle.status !== 'pending') {
        this.opts.logger.debug(
          { delegateEventId, resolution: handle.resolution },
          'Late delegation: response matched an already-resolved handle — ignoring',
        );
        return;
      }

      await handleLateResponse({
        pool: this.opts.pool,
        bus: this.opts.bus,
        taskRepo: this.opts.taskRepo,
        logger: this.opts.logger,
        handle,
        responsePayload: event.payload as unknown as Record<string, unknown>,
        responseEventId: event.id,
        respondedAt: event.timestamp,
        maxResultChars: this.opts.maxResultChars,
        ...(this.opts.timezone !== undefined && { timezone: this.opts.timezone }),
      });
    } catch (err) {
      // Leave the handle pending: the sweep finds this same response in audit_log on a later
      // tick and retries, so a transient DB failure here delays the outcome rather than losing it.
      this.opts.logger.error(
        { err, delegateEventId, responseEventId: event.id },
        'Late delegation: failed to resolve a matched late response — the sweep will retry',
      );
      throw err;
    }
  }
}
