// plan-frontier-subscriber.ts — child→parent wake + frontier advancement (#1238).
// Applies the progress-based circuit breaker on planned-parent wakes (#1239).

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { ResumableCeilingsConfig } from '../config.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { TaskRepo } from '../db/task-repo.js';
import type {
  ScheduleFiredEvent,
  TaskCompletedEvent,
  TaskUpdatedEvent,
} from '../bus/events.js';
import { readPlanBlock } from '../db/plan-progress.js';
import { handlePlanFrontierWakeForCircuitBreaker } from './resumable-circuit-breaker.js';
import {
  detectPlanAdaptiveBreach,
  escalatePlanAdaptiveBreach,
  readPlanAdaptiveState,
} from './plan-adaptive-replan.js';
import {
  advancePlanFrontier,
  handleChildTerminalResolution,
  isChildTerminalStatus,
} from './plan-frontier.js';

export interface PlanFrontierSubscriberOptions {
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
 * System-layer subscriber: when a planned child resolves, schedule a near-term parent
 * wake. When that parent wake fires, recompute rollup and dispatch unblocked children.
 */
export class PlanFrontierSubscriber {
  constructor(private readonly opts: PlanFrontierSubscriberOptions) {}

  start(): void {
    this.opts.bus.subscribe('task.updated', 'system', async (event) => {
      const updated = event as TaskUpdatedEvent;
      const { newStatus, taskId } = updated.payload;
      if (!newStatus || !isChildTerminalStatus(newStatus)) return;

      try {
        await handleChildTerminalResolution({
          pool: this.opts.pool,
          schedulerService: this.opts.schedulerService,
          logger: this.opts.logger,
          childTaskId: taskId,
          delaySeconds: this.opts.continuationDelaySeconds,
          eligibleAgents: this.opts.eligibleAgents,
          fallbackAgentId: this.opts.fallbackAgentId,
        });
      } catch (err) {
        this.opts.logger.error({ err, taskId }, 'Plan frontier: failed to handle child task.updated');
        throw err;
      }
    });

    this.opts.bus.subscribe('task.completed', 'system', async (event) => {
      const completed = event as TaskCompletedEvent;
      const { taskId } = completed.payload;

      try {
        await handleChildTerminalResolution({
          pool: this.opts.pool,
          schedulerService: this.opts.schedulerService,
          logger: this.opts.logger,
          childTaskId: taskId,
          delaySeconds: this.opts.continuationDelaySeconds,
          eligibleAgents: this.opts.eligibleAgents,
          fallbackAgentId: this.opts.fallbackAgentId,
        });
      } catch (err) {
        this.opts.logger.error({ err, taskId }, 'Plan frontier: failed to handle child task.completed');
        throw err;
      }
    });

    this.opts.bus.subscribe('schedule.fired', 'system', async (event) => {
      const fired = event as ScheduleFiredEvent;
      const parentTaskId = fired.payload.agentTaskId;
      if (!parentTaskId) return;

      try {
        const parent = await this.opts.taskRepo.getTask(parentTaskId);
        if (!parent || !readPlanBlock(parent.progress)) return;

        const result = await advancePlanFrontier({
          pool: this.opts.pool,
          taskRepo: this.opts.taskRepo,
          schedulerService: this.opts.schedulerService,
          logger: this.opts.logger,
          parentTaskId,
          eligibleAgents: this.opts.eligibleAgents,
          fallbackAgentId: this.opts.fallbackAgentId,
          resumableCeilings: this.opts.resumableCeilings,
        });

        if (!result || result.autoCompleted) return;

        const parentAfter = await this.opts.taskRepo.getTask(parentTaskId);
        if (parentAfter) {
          const adaptive = readPlanAdaptiveState(parentAfter.progress);
          if (adaptive) {
            // Defense-in-depth: the handler is the primary depth gate and refuses to persist
            // a breaching depth, so this path is unreachable in normal operation unless state
            // was hand-edited or predates the handler guard.
            const depthBreach = detectPlanAdaptiveBreach(
              adaptive,
              this.opts.resumableCeilings,
              parentAfter.errorBudget,
            );
            if (depthBreach) {
              await escalatePlanAdaptiveBreach({
                bus: this.opts.bus,
                taskRepo: this.opts.taskRepo,
                logger: this.opts.logger,
                task: parentAfter,
                breach: depthBreach,
                agentId: fired.payload.agentId,
              });
              return;
            }
          }
        }

        await handlePlanFrontierWakeForCircuitBreaker({
          pool: this.opts.pool,
          bus: this.opts.bus,
          taskRepo: this.opts.taskRepo,
          logger: this.opts.logger,
          taskId: parentTaskId,
          snapshot: result.frontierSnapshot,
          ceilings: this.opts.resumableCeilings,
          agentId: fired.payload.agentId,
        });
      } catch (err) {
        this.opts.logger.error({ err, parentTaskId }, 'Plan frontier: failed to advance on parent wake');
        throw err;
      }
    });

    this.opts.logger.info(
      {
        continuationDelaySeconds: this.opts.continuationDelaySeconds,
        resumableCeilings: this.opts.resumableCeilings,
      },
      'PlanFrontierSubscriber started',
    );
  }
}
