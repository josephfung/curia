import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { SchedulerService } from './scheduler-service.js';
import type { AgentYamlConfig } from '../agents/loader.js';
import {
  createScheduleFired,
  createScheduleSuspended,
  createAgentTask,
} from '../bus/events.js';
import type { AgentResponseEvent, AgentErrorEvent } from '../bus/events.js';
import type { JobRow } from './scheduler-service.js';

// Poll every 30 seconds for due jobs.
export const POLL_INTERVAL_MS = 30_000;

export interface SchedulerConfig {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  schedulerService: SchedulerService;
}

export class Scheduler {
  private pool: Pool;
  private bus: EventBus;
  private logger: Logger;
  private schedulerService: SchedulerService;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  // Maps the agent.task event ID back to the job ID so we can match
  // agent.response / agent.error events to the originating scheduled job.
  private pendingJobs = new Map<string, string>();

  constructor(config: SchedulerConfig) {
    this.pool = config.pool;
    this.bus = config.bus;
    this.logger = config.logger;
    this.schedulerService = config.schedulerService;
  }

  /**
   * Start the scheduler loop.
   * Sets up bus subscribers for completion tracking, then starts the polling interval.
   */
  start(): void {
    // Subscribe to agent.response on system layer to track successful completions.
    this.bus.subscribe('agent.response', 'system', (event) => {
      const responseEvent = event as AgentResponseEvent;
      if (responseEvent.parentEventId) {
        void this.handleCompletion(responseEvent.parentEventId, true);
      }
    });

    // Subscribe to agent.error on system layer to track failures.
    this.bus.subscribe('agent.error', 'system', (event) => {
      const errorEvent = event as AgentErrorEvent;
      if (errorEvent.parentEventId) {
        void this.handleCompletion(
          errorEvent.parentEventId,
          false,
          errorEvent.payload.message,
        );
      }
    });

    this.intervalHandle = setInterval(() => {
      void this.pollDueJobs();
    }, POLL_INTERVAL_MS);

    this.logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Scheduler started');
  }

  /**
   * Stop the scheduler loop.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.logger.info('Scheduler stopped');
  }

  /**
   * Poll for due jobs and fire each one.
   * Public for testing — normally called by the interval.
   *
   * Uses FOR UPDATE SKIP LOCKED to safely claim jobs in a concurrent environment
   * (multiple scheduler instances won't double-fire the same job).
   */
  async pollDueJobs(): Promise<void> {
    try {
      const sql = `
        SELECT sj.*,
               at.id AS agent_task_id,
               at.intent_anchor,
               at.progress
          FROM scheduled_jobs sj
          LEFT JOIN agent_tasks at ON at.scheduled_job_id = sj.id
         WHERE sj.status = 'pending'
           AND sj.next_run_at <= now()
         ORDER BY sj.next_run_at ASC
         FOR UPDATE OF sj SKIP LOCKED
      `;
      const { rows } = await this.pool.query(sql);

      for (const row of rows) {
        // Map the snake_case DB row to the camelCase JobRow shape.
        const job: JobRow = {
          id: row.id,
          agentId: row.agent_id,
          cronExpr: row.cron_expr,
          runAt: row.run_at,
          taskPayload: row.task_payload,
          status: row.status,
          lastRunAt: row.last_run_at,
          nextRunAt: row.next_run_at,
          lastError: row.last_error,
          consecutiveFailures: row.consecutive_failures,
          createdBy: row.created_by,
          createdAt: row.created_at,
          agentTaskId: row.agent_task_id ?? null,
          intentAnchor: row.intent_anchor ?? null,
          progress: row.progress ?? null,
        };
        await this.fireJob(job);
      }

      if (rows.length > 0) {
        this.logger.info({ count: rows.length }, 'Polled and fired due jobs');
      }
    } catch (err) {
      this.logger.error({ err }, 'Error polling due jobs');
    }
  }

  /**
   * Fire a single job: set status to running, publish schedule.fired + agent.task.
   *
   * For persistent tasks (linked agent_task), injects intent_anchor and progress
   * into the agent.task content so the agent has context about the ongoing task.
   */
  private async fireJob(job: JobRow): Promise<void> {
    // Mark job as running so it won't be picked up again.
    await this.pool.query(
      `UPDATE scheduled_jobs SET status = $1 WHERE id = $2`,
      ['running', job.id],
    );

    // Build the agent.task content, injecting persistent task context if available.
    let content = JSON.stringify(job.taskPayload);
    if (job.agentTaskId && job.intentAnchor) {
      const context = {
        intent_anchor: job.intentAnchor,
        progress: job.progress ?? {},
        task_payload: job.taskPayload,
      };
      content = JSON.stringify(context);
    }

    // Publish schedule.fired for audit trail.
    const firedEvent = createScheduleFired({
      jobId: job.id,
      agentId: job.agentId,
      agentTaskId: job.agentTaskId,
    });
    await this.bus.publish('system', firedEvent);

    // Publish agent.task so the coordinator picks up the work.
    const taskEvent = createAgentTask({
      agentId: job.agentId,
      conversationId: `scheduler:${job.id}`,
      channelId: 'scheduler',
      senderId: 'scheduler',
      content,
      parentEventId: firedEvent.id,
    });
    await this.bus.publish('system', taskEvent);

    // Track the mapping so we can correlate the response/error back to this job.
    this.pendingJobs.set(taskEvent.id, job.id);

    this.logger.info(
      { jobId: job.id, agentId: job.agentId, taskEventId: taskEvent.id },
      'Job fired',
    );
  }

  /**
   * Handle a completion event (agent.response or agent.error) by matching
   * the parentEventId back to a pending job and completing the job run.
   */
  private async handleCompletion(
    parentEventId: string,
    success: boolean,
    error?: string,
  ): Promise<void> {
    const jobId = this.pendingJobs.get(parentEventId);
    if (!jobId) {
      // Not a scheduler-originated event — ignore silently.
      return;
    }

    // Clean up the tracking map.
    this.pendingJobs.delete(parentEventId);

    try {
      const result = await this.schedulerService.completeJobRun(jobId, success, error);

      if (result.suspended) {
        // Publish schedule.suspended for audit trail.
        const suspendedEvent = createScheduleSuspended({
          jobId,
          agentId: '', // Will be filled from the job; fetch is not needed since we log the jobId.
          lastError: error ?? 'Unknown error',
          consecutiveFailures: 3, // At suspension threshold.
          parentEventId,
        });

        // We need the agentId for the suspended event; look it up from the job.
        // TODO: Consider caching the agentId in the pendingJobs map to avoid this query.
        const job = await this.schedulerService.getJob(jobId);
        if (job) {
          const event = createScheduleSuspended({
            jobId,
            agentId: job.agentId,
            lastError: error ?? 'Unknown error',
            consecutiveFailures: job.consecutiveFailures,
            parentEventId,
          });
          await this.bus.publish('system', event);

          // Suppress the unused suspendedEvent variable — we rebuilt it with the correct agentId.
          void suspendedEvent;

          // Publish a synthetic agent.task to the coordinator so the user gets notified
          // about the suspension (e.g., "your scheduled job was suspended after 3 failures").
          const notifyEvent = createAgentTask({
            agentId: job.agentId,
            conversationId: `scheduler:${jobId}`,
            channelId: 'scheduler',
            senderId: 'scheduler',
            content: JSON.stringify({
              type: 'schedule_suspended',
              jobId,
              lastError: error ?? 'Unknown error',
              consecutiveFailures: job.consecutiveFailures,
            }),
            parentEventId: event.id,
          });
          await this.bus.publish('system', notifyEvent);
        }
      }
    } catch (err) {
      this.logger.error({ err, jobId, parentEventId }, 'Error completing job run');
    }
  }

  /**
   * Load declarative jobs from agent YAML configs.
   * For each config that has a `schedule` block, upserts the declarative jobs
   * so they're always present in the DB on startup.
   */
  async loadDeclarativeJobs(agentConfigs: AgentYamlConfig[]): Promise<void> {
    for (const config of agentConfigs) {
      if (!config.schedule || config.schedule.length === 0) {
        continue;
      }

      for (const schedule of config.schedule) {
        try {
          const jobId = await this.schedulerService.upsertDeclarativeJob(
            config.name,
            schedule,
          );
          this.logger.info(
            { agentId: config.name, cron: schedule.cron, task: schedule.task, jobId },
            'Declarative job upserted',
          );
        } catch (err) {
          this.logger.error(
            { err, agentId: config.name, schedule },
            'Failed to upsert declarative job',
          );
        }
      }
    }
  }
}
