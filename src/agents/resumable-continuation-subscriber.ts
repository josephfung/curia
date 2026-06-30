// resumable-continuation-subscriber.ts — schedules near-term wakes on execution_paused (#1175).
// Applies the progress-based circuit breaker before scheduling (#1176).

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { ResumableCeilingsConfig } from '../config.js';
import type { AgentResponseEvent } from '../bus/events.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { TaskRepo } from '../db/task-repo.js';
import { parseExecutionPausedPayload } from './resumable-task.js';
import { scheduleResumableContinuation } from './resumable-continuation.js';
import { handlePausedSliceForCircuitBreaker } from './resumable-circuit-breaker.js';

export interface ResumableContinuationSubscriberOptions {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  schedulerService: SchedulerService;
  taskRepo: TaskRepo;
  eligibleAgents: Set<string>;
  continuationDelaySeconds: number;
  resumableCeilings: ResumableCeilingsConfig;
  fallbackAgentId?: string;
}

/**
 * System-layer subscriber: when a specialist emits execution_paused, evaluate the
 * progress-based circuit breaker, then enqueue a single near-term continuation wake
 * routed to the task's source_agent_id (or coordinator) when healthy.
 */
export class ResumableContinuationSubscriber {
  constructor(private readonly opts: ResumableContinuationSubscriberOptions) {}

  start(): void {
    this.opts.bus.subscribe('agent.response', 'system', async (event) => {
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

      let sliceCostUsd: number | undefined;
      if (paused.slice_cost_usd !== undefined) {
        if (Number.isFinite(paused.slice_cost_usd) && paused.slice_cost_usd >= 0) {
          sliceCostUsd = paused.slice_cost_usd;
        } else {
          this.opts.logger.warn(
            { taskId, sliceCostUsd: paused.slice_cost_usd },
            'execution_paused slice_cost_usd invalid — ignoring',
          );
        }
      }

      try {
        const breaker = await handlePausedSliceForCircuitBreaker({
          pool: this.opts.pool,
          bus: this.opts.bus,
          taskRepo: this.opts.taskRepo,
          logger: this.opts.logger,
          taskId,
          paused,
          ceilings: this.opts.resumableCeilings,
          agentId: responseEvent.payload.agentId,
          sliceCostUsd,
          parentEventId: responseEvent.id,
        });

        if (!breaker.scheduleContinuation) {
          return;
        }

        await scheduleResumableContinuation({
          pool: this.opts.pool,
          schedulerService: this.opts.schedulerService,
          logger: this.opts.logger,
          taskId,
          delaySeconds: this.opts.continuationDelaySeconds,
          eligibleAgents: this.opts.eligibleAgents,
          fallbackAgentId: this.opts.fallbackAgentId,
        });
      } catch (err) {
        this.opts.logger.error(
          { err, taskId, agentId: responseEvent.payload.agentId },
          'Failed to process resumable pause / schedule continuation',
        );
        throw err;
      }
    });

    this.opts.logger.info(
      {
        continuationDelaySeconds: this.opts.continuationDelaySeconds,
        resumableCeilings: this.opts.resumableCeilings,
      },
      'ResumableContinuationSubscriber started',
    );
  }
}
