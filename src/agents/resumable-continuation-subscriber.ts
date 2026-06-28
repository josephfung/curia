// resumable-continuation-subscriber.ts — schedules near-term wakes on execution_paused (#1175).

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { AgentResponseEvent } from '../bus/events.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import { parseExecutionPausedPayload } from './resumable-task.js';
import { scheduleResumableContinuation } from './resumable-continuation.js';

export interface ResumableContinuationSubscriberOptions {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  schedulerService: SchedulerService;
  eligibleAgents: Set<string>;
  continuationDelaySeconds: number;
  fallbackAgentId?: string;
}

/**
 * System-layer subscriber: when a specialist emits execution_paused, enqueue a single
 * near-term continuation wake routed to the task's source_agent_id (or coordinator).
 */
export class ResumableContinuationSubscriber {
  constructor(private readonly opts: ResumableContinuationSubscriberOptions) {}

  start(): void {
    this.opts.bus.subscribe('agent.response', 'system', (event) => {
      const responseEvent = event as AgentResponseEvent;
      if (responseEvent.payload.isError) return;

      const paused = parseExecutionPausedPayload(responseEvent.payload.content);
      if (!paused) return;

      const taskId = paused.task_id;
      if (!taskId) {
        this.opts.logger.warn(
          { agentId: responseEvent.payload.agentId },
          'execution_paused response missing task_id — cannot schedule continuation',
        );
        return;
      }

      scheduleResumableContinuation({
        pool: this.opts.pool,
        schedulerService: this.opts.schedulerService,
        logger: this.opts.logger,
        taskId,
        delaySeconds: this.opts.continuationDelaySeconds,
        eligibleAgents: this.opts.eligibleAgents,
        fallbackAgentId: this.opts.fallbackAgentId,
      }).catch((err) => {
        this.opts.logger.error(
          { err, taskId, agentId: responseEvent.payload.agentId },
          'Failed to schedule resumable continuation wake',
        );
      });
    });

    this.opts.logger.info(
      { continuationDelaySeconds: this.opts.continuationDelaySeconds },
      'ResumableContinuationSubscriber started',
    );
  }
}
