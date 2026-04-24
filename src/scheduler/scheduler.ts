import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { SchedulerService } from './scheduler-service.js';
import type { AgentYamlConfig } from '../agents/loader.js';
import {
  createScheduleFired,
  createScheduleSuspended,
  createScheduleRecovered,
  createScheduleDriftPaused,
  createAgentTask,
} from '../bus/events.js';
import type { AgentResponseEvent, AgentErrorEvent } from '../bus/events.js';
import type { DriftDetector } from './drift-detector.js';
import type { DreamEngine } from '../memory/dream-engine.js';
import type { JobRow } from './scheduler-service.js';

// Poll every 30 seconds for due jobs.
export const POLL_INTERVAL_MS = 30_000;

// Watchdog runs every 5 minutes to detect jobs stuck mid-run.
export const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

// Default assumed duration for a job with no explicit expectedDurationSeconds.
const DEFAULT_EXPECTED_DURATION_SECONDS = 600; // 10 minutes

// Timeout = min(expected × MULTIPLIER, expected + CAP). Gives larger headroom for
// short jobs while capping the maximum extension at +60 minutes for long ones.
//   2m expected → 15m timeout;  30m expected → 90m timeout.
const RECOVERY_TIMEOUT_MULTIPLIER = 7.5;
const RECOVERY_TIMEOUT_CAP_SECONDS = 3600;

/**
 * Build a structured text block summarising the previous run's outcome.
 * Injected into the agent.task content so the agent can avoid repeating work
 * or adjust its approach based on what happened last time.
 *
 * Returns an empty string when there is no prior-run data (first run ever).
 */
function buildPriorRunBlock(job: JobRow): string {
  if (!job.lastRunOutcome) return '';

  const lastRanStr = job.lastRunAt
    ? new Date(job.lastRunAt).toLocaleString('en-CA', { timeZone: job.timezone, dateStyle: 'short', timeStyle: 'short' })
    : job.lastRunOutcome === 'timed_out'
      ? 'no completion recorded (timed out)'
      : 'no completion recorded';

  const parts: string[] = [
    `[Prior run context — ${lastRanStr}]`,
    `Outcome: ${job.lastRunOutcome}`,
  ];

  if (job.lastRunSummary) {
    parts.push(`Summary: ${job.lastRunSummary}`);
  }

  if (job.lastRunContext) {
    parts.push(`Agent context: ${JSON.stringify(job.lastRunContext, null, 2)}`);
  }

  return parts.join('\n');
}

/**
 * Compute the recovery timeout for a job given its expected duration.
 * Exported for unit testing; the SQL query in recoverStuckJobs() mirrors this formula.
 */
export function computeRecoveryTimeout(expectedDurationSeconds: number): number {
  return Math.min(
    expectedDurationSeconds * RECOVERY_TIMEOUT_MULTIPLIER,
    expectedDurationSeconds + RECOVERY_TIMEOUT_CAP_SECONDS,
  );
}

export interface SchedulerConfig {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  schedulerService: SchedulerService;
  /** Optional drift detector — when absent, the drift check is skipped entirely. */
  driftDetector?: DriftDetector;
  /** Dream engine for background KG maintenance. When absent, no background decay runs. */
  dreamEngine?: DreamEngine;
}

export class Scheduler {
  private pool: Pool;
  private bus: EventBus;
  private logger: Logger;
  private schedulerService: SchedulerService;
  private driftDetector?: DriftDetector;
  private dreamEngine?: DreamEngine;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private watchdogHandle: ReturnType<typeof setInterval> | null = null;

  // Maps the agent.task event ID back to the job ID so we can match
  // agent.response / agent.error events to the originating scheduled job.
  private pendingJobs = new Map<string, string>();

  // Tracks burst counts per job for checkEveryNBursts support.
  // In-memory only — resets on process restart (a missed check is not a security failure).
  private burstCounts = new Map<string, number>();

  constructor(config: SchedulerConfig) {
    this.pool = config.pool;
    this.bus = config.bus;
    this.logger = config.logger;
    this.schedulerService = config.schedulerService;
    this.driftDetector = config.driftDetector;
    this.dreamEngine = config.dreamEngine;
  }

  /**
   * Start the scheduler loop.
   * Sets up bus subscribers for completion tracking, then starts the polling interval.
   */
  start(): void {
    // Subscribe to agent.response on system layer to track successful completions.
    // Error responses (isError: true) are skipped here — the agent.error subscriber
    // below handles failures. This avoids a double handleCompletion call on the same
    // parentEventId (the runtime emits both agent.error and agent.response on failure).
    this.bus.subscribe('agent.response', 'system', (event) => {
      const responseEvent = event as AgentResponseEvent;
      if (responseEvent.payload.isError) return;
      if (responseEvent.parentEventId) {
        this.handleCompletion(responseEvent.parentEventId, true).catch((err) => {
          this.logger.error({ err, parentEventId: responseEvent.parentEventId }, 'Unhandled error in handleCompletion (success path)');
        });
      }
    });

    // Subscribe to agent.error on system layer to track failures.
    this.bus.subscribe('agent.error', 'system', (event) => {
      const errorEvent = event as AgentErrorEvent;
      if (errorEvent.parentEventId) {
        this.handleCompletion(
          errorEvent.parentEventId,
          false,
          errorEvent.payload.message,
        ).catch((err) => {
          this.logger.error({ err, parentEventId: errorEvent.parentEventId }, 'Unhandled error in handleCompletion (failure path)');
        });
      }
    });

    this.intervalHandle = setInterval(() => {
      this.pollDueJobs().catch((err) => {
        this.logger.error({ err }, 'Unhandled error in pollDueJobs');
      });
    }, POLL_INTERVAL_MS);

    // Watchdog: periodically recover jobs that got stuck in 'running' state.
    this.watchdogHandle = setInterval(() => {
      this.recoverStuckJobs().catch((err) => {
        this.logger.error({ err }, 'Unhandled error in recoverStuckJobs watchdog');
      });
    }, WATCHDOG_INTERVAL_MS);

    // Dream engine — background KG maintenance (decay, and future passes).
    if (this.dreamEngine) {
      this.dreamEngine.start();
    }

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
    if (this.watchdogHandle) {
      clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
    if (this.dreamEngine) {
      this.dreamEngine.stop();
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
         WHERE sj.status IN ('pending', 'failed')
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
          timezone: row.timezone as string,
          agentTaskId: row.agent_task_id ?? null,
          intentAnchor: row.intent_anchor ?? null,
          progress: row.progress ?? null,
          runStartedAt: row.run_started_at ?? null,
          expectedDurationSeconds: row.expected_duration_seconds ?? null,
          lastRunOutcome: row.last_run_outcome ?? null,
          lastRunSummary: row.last_run_summary ?? null,
          lastRunContext: row.last_run_context ?? null,
        };
        try {
          await this.fireJob(job);
        } catch (err) {
          this.logger.error({ err, jobId: job.id }, 'Failed to fire job — reverting to pending for retry');
          // Clean up the pendingJobs entry that fireJob sets before publishing.
          // Without this, a publish failure after pendingJobs.set() leaks an
          // orphaned entry that the watchdog won't clean (job reverts to 'pending',
          // not 'running', so the watchdog's WHERE clause never matches).
          for (const [eventId, pendingJobId] of this.pendingJobs) {
            if (pendingJobId === job.id) {
              this.pendingJobs.delete(eventId);
              break;
            }
          }
          // Revert the job to its prior status so it can be retried next poll.
          // If this revert also fails, the job stays in 'running' — logged below.
          await this.pool.query(
            `UPDATE scheduled_jobs SET status = 'pending' WHERE id = $1 AND status = 'running'`,
            [job.id],
          ).catch((revertErr) => {
            this.logger.error({ revertErr, jobId: job.id }, 'Failed to revert job status after fire failure — job may be stuck in running');
          });
        }
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
   * For persistent tasks (linked agent_task), includes progress and task_payload
   * in content for agent context. The intent anchor is passed separately in the
   * event payload so the runtime can inject it into the system prompt as a
   * non-negotiable behavioral instruction.
   */
  private async fireJob(job: JobRow): Promise<void> {
    // Atomically claim the job by setting status to 'running' only if it's still
    // in a claimable state. The rowCount check prevents double-firing if another
    // scheduler instance (or overlapping poll) claimed the same job.
    const claimResult = await this.pool.query(
      `UPDATE scheduled_jobs SET status = $1, run_started_at = now() WHERE id = $2 AND status IN ('pending', 'failed')`,
      ['running', job.id],
    );
    if (claimResult.rowCount === 0) {
      this.logger.debug({ jobId: job.id }, 'Job already claimed; skipping fire');
      return;
    }

    // Build the agent.task content. For persistent tasks, include progress and
    // the original task payload so the agent has execution context. Intent anchor
    // is passed in the event payload (not content) so the runtime can inject it
    // into the system prompt as a non-negotiable behavioral instruction.
    let content = JSON.stringify(job.taskPayload);
    if (job.agentTaskId) {
      content = JSON.stringify({
        progress: job.progress ?? {},
        task_payload: job.taskPayload,
      });
    }

    // Prepend prior-run context so the agent knows what happened last time
    // and can avoid repeating work or adjust its approach accordingly.
    const priorRunBlock = buildPriorRunBlock(job);
    if (priorRunBlock) {
      content = `${priorRunBlock}\n\n${content}`;
    }

    // Publish schedule.fired for audit trail.
    const firedEvent = createScheduleFired({
      jobId: job.id,
      agentId: job.agentId,
      agentTaskId: job.agentTaskId,
    });
    await this.bus.publish('system', firedEvent);

    // Use a unique per-run conversationId so that each scheduler invocation gets
    // its own conversation thread. Re-using just the job ID would let unrelated
    // runs bleed into the same conversation history.
    const runId = randomUUID();

    // Publish agent.task so the coordinator picks up the work.
    const taskEvent = createAgentTask({
      agentId: job.agentId,
      conversationId: `scheduler:${job.id}:${runId}`,
      channelId: 'scheduler',
      senderId: 'scheduler',
      content,
      // Pass the anchor in the payload so the runtime injects it into the system
      // prompt. null (no linked agent_task) becomes undefined (field omitted).
      intentAnchor: job.intentAnchor ?? undefined,
      // Pass the duration hint so the runtime can widen the delegate timeout for
      // long-running scheduled tasks. null (no explicit duration) becomes undefined.
      expectedDurationSeconds: job.expectedDurationSeconds ?? undefined,
      parentEventId: firedEvent.id,
    });
    // Track the mapping BEFORE publishing — bus.publish() awaits all handlers
    // synchronously, so the agent may finish and emit agent.response before
    // publish() returns. If we set the entry after publish, handleCompletion
    // sees an empty map and silently drops the completion.
    this.pendingJobs.set(taskEvent.id, job.id);

    await this.bus.publish('system', taskEvent);

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
      // Run the drift check on the success path for persistent tasks only.
      // Skip on the failure path — the error handling flow takes over.
      if (success && this.driftDetector) {
        const job = await this.schedulerService.getJob(jobId);

        if (job?.agentTaskId && job.intentAnchor) {
          // Enforce checkEveryNBursts: only check on the Nth burst.
          const burstCount = (this.burstCounts.get(jobId) ?? 0) + 1;
          this.burstCounts.set(jobId, burstCount);

          const shouldCheck = burstCount % this.driftDetector.checkEveryNBursts === 0;

          if (shouldCheck) {
            const verdict = await this.driftDetector.check({
              intentAnchor: job.intentAnchor,
              taskPayload: job.taskPayload,
              lastRunSummary: job.lastRunSummary ?? null,
            });

            if (verdict !== null) {
              this.logger.info(
                { jobId, agentTaskId: job.agentTaskId, drifted: verdict.drifted, confidence: verdict.confidence, reason: verdict.reason },
                'drift-detector: verdict',
              );

              if (this.driftDetector.shouldPause(verdict)) {
                // Hard pause: set status to paused, publish the drift event, notify CEO.
                // Wrapped in its own try/catch so a failure here falls back to normal
                // completion — preventing the job from being left in 'running' state.
                let pauseSucceeded = false;
                try {
                  await this.schedulerService.pauseJobForDrift(jobId);

                  const driftEvent = createScheduleDriftPaused({
                    jobId,
                    agentId: job.agentId,
                    agentTaskId: job.agentTaskId,
                    intentAnchor: job.intentAnchor,
                    taskPayload: job.taskPayload,
                    lastRunSummary: job.lastRunSummary ?? null,
                    verdict,
                    parentEventId,
                  });
                  await this.bus.publish('system', driftEvent);

                  // Notify the CEO via the coordinator (same pattern as schedule.suspended).
                  const notifyContent = [
                    `Task has been paused because its current instructions may have drifted from its original goal.`,
                    ``,
                    `Original intent: ${job.intentAnchor}`,
                    ``,
                    `Current task: ${JSON.stringify(job.taskPayload)}`,
                    ``,
                    `Reason: ${verdict.reason} (confidence: ${verdict.confidence})`,
                    ``,
                    `Please review the task and either resume it with corrected instructions or cancel it.`,
                  ].join('\n');

                  const notifyEvent = createAgentTask({
                    agentId: 'coordinator',
                    conversationId: `scheduler:${jobId}`,
                    channelId: 'scheduler',
                    senderId: 'scheduler',
                    content: notifyContent,
                    parentEventId: driftEvent.id,
                  });
                  await this.bus.publish('system', notifyEvent);

                  this.logger.warn(
                    { jobId, agentTaskId: job.agentTaskId, reason: verdict.reason, confidence: verdict.confidence },
                    'Job paused due to intent drift detection',
                  );

                  // Do NOT call completeJobRun — the job is paused, not completed.
                  // Clean up burst counter: paused jobs don't burst again.
                  this.burstCounts.delete(jobId);
                  pauseSucceeded = true;
                } catch (pauseErr) {
                  this.logger.error(
                    { err: pauseErr, jobId, agentTaskId: job.agentTaskId },
                    'drift-detector: pause-and-notify failed — falling back to normal completion',
                  );
                }

                if (pauseSucceeded) return;
              }
            }
          }
        }
      }

      const result = await this.schedulerService.completeJobRun(jobId, success, error);

      if (result.suspended) {
        // Fetch the job to get the agentId and consecutiveFailures for the event.
        const job = await this.schedulerService.getJob(jobId);
        if (job) {
          // Publish schedule.suspended for audit trail.
          const suspendedEvent = createScheduleSuspended({
            jobId,
            agentId: job.agentId,
            lastError: error ?? 'Unknown error',
            consecutiveFailures: job.consecutiveFailures,
            parentEventId,
          });
          await this.bus.publish('system', suspendedEvent);

          // Publish a synthetic agent.task to the coordinator so the user gets notified
          // about the suspension (e.g., "your scheduled job was suspended after 3 failures").
          // Always routes to coordinator — it's the user-facing agent that can deliver notifications.
          const notifyEvent = createAgentTask({
            agentId: 'coordinator',
            conversationId: `scheduler:${jobId}`,
            channelId: 'scheduler',
            senderId: 'scheduler',
            content: JSON.stringify({
              type: 'schedule_suspended',
              jobId,
              lastError: error ?? 'Unknown error',
              consecutiveFailures: job.consecutiveFailures,
            }),
            parentEventId: suspendedEvent.id,
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
    const knownAgents = new Set(agentConfigs.map(config => config.name));
    // Collect all (source → target) schedule edges for cycle detection after upserts.
    const edges: Array<{ source: string; target: string }> = [];

    for (const config of agentConfigs) {
      if (!config.schedule || config.schedule.length === 0) {
        continue;
      }

      for (const schedule of config.schedule) {
        // agent_id lets a specialist declare its schedule fires at a different agent
        // (e.g. coordinator). Defaults to the agent's own name if omitted.
        const targetAgentId = schedule.agent_id ?? config.name;

        // Reject unknown targets early — a typo in agent_id would silently write a
        // job that targets nobody. Fail loudly at startup instead.
        if (!knownAgents.has(targetAgentId)) {
          this.logger.error(
            { sourceAgent: config.name, targetAgentId, cron: schedule.cron, task: schedule.task },
            'Skipping declarative job — target agent_id is not a known agent',
          );
          continue;
        }

        try {
          const jobId = await this.schedulerService.upsertDeclarativeJob(
            targetAgentId,
            schedule,
          );
          // Only record the edge after a successful upsert — a failed upsert means
          // the job doesn't exist in the DB, so it shouldn't influence cycle detection.
          edges.push({ source: config.name, target: targetAgentId });
          this.logger.info(
            { agentId: targetAgentId, sourceAgent: config.name, cron: schedule.cron, task: schedule.task, jobId },
            'Declarative job upserted',
          );
        } catch (err) {
          this.logger.error(
            { err, agentId: targetAgentId, sourceAgent: config.name, schedule },
            'Failed to upsert declarative job',
          );
        }
      }
    }

    // Detect two-agent targeting cycles and warn loudly. A cycle means agent A's schedule
    // targets agent B, and agent B's schedule targets agent A — this will cause infinite
    // task loops at runtime. Self-targeting (source === target) is intentional and fine.
    //
    // Use a Set keyed on the canonical (sorted) pair to warn exactly once per pair,
    // even if one agent has multiple schedules targeting the other.
    const warnedPairs = new Set<string>();
    for (const edge of edges) {
      if (edge.source === edge.target) continue; // self-targeting is fine
      const hasCycle = edges.some(
        e => e.source === edge.target && e.target === edge.source,
      );
      const pairKey = [edge.source, edge.target].sort().join('::');
      if (hasCycle && !warnedPairs.has(pairKey)) {
        warnedPairs.add(pairKey);
        this.logger.warn(
          { agentA: edge.source, agentB: edge.target },
          'Declarative schedule cycle detected — agents target each other; this will cause infinite task loops',
        );
      }
    }
  }

  /**
   * Detect and recover jobs stuck in 'running' state beyond their timeout threshold.
   * Called at startup (before scheduler.start()) and by the watchdog loop every 5 minutes.
   *
   * Timeout formula: min(expected × 7.5, expected + 3600s)
   * This gives proportionally more headroom to short jobs while capping the max extension
   * at +60 minutes for long-running jobs.
   *
   * Jobs with NULL run_started_at (e.g., stuck before this migration ran) are always recovered.
   */
  async recoverStuckJobs(): Promise<void> {
    // Find all running jobs that have exceeded their timeout. The LEAST() formula mirrors
    // the JS constants above — keep them in sync if the formula ever changes.
    // run_started_at IS NULL handles jobs stuck before this migration added the column.
    const sql = `
      SELECT
        id,
        agent_id,
        run_started_at,
        LEAST(
          COALESCE(expected_duration_seconds, $1)::float8 * $2,
          (COALESCE(expected_duration_seconds, $1) + $3)::float8
        )::integer AS timeout_seconds
      FROM scheduled_jobs
      WHERE status = 'running'
        AND (
          run_started_at IS NULL
          OR run_started_at < now() - make_interval(secs =>
              LEAST(
                COALESCE(expected_duration_seconds, $1)::float8 * $2,
                (COALESCE(expected_duration_seconds, $1) + $3)::float8
              )
            )
        )
      FOR UPDATE SKIP LOCKED
    `;
    const { rows } = await this.pool.query(sql, [
      DEFAULT_EXPECTED_DURATION_SECONDS,
      RECOVERY_TIMEOUT_MULTIPLIER,
      RECOVERY_TIMEOUT_CAP_SECONDS,
    ]);

    if (rows.length === 0) {
      this.logger.debug('recoverStuckJobs: no stuck jobs found');
      return;
    }

    this.logger.warn({ count: rows.length }, 'Recovering stuck jobs');

    for (const row of rows as Array<{ id: string; agent_id: string; run_started_at: string | null; timeout_seconds: number }>) {
      try {
        const result = await this.schedulerService.recoverStuckJob(row.id, row.timeout_seconds);

        if (!result.noOp) {
          // Remove any stale pendingJobs entry so a late agent.response for the
          // old run cannot complete the freshly-reset job.
          for (const [eventId, pendingJobId] of this.pendingJobs) {
            if (pendingJobId === row.id) {
              this.pendingJobs.delete(eventId);
              this.burstCounts.delete(row.id);
              this.logger.debug({ jobId: row.id, eventId }, 'Removed stale pendingJobs entry for recovered job');
              break; // At most one entry per job
            }
          }

          this.logger.warn(
            {
              jobId: row.id,
              agentId: row.agent_id,
              runStartedAt: row.run_started_at,
              timeoutSeconds: row.timeout_seconds,
              consecutiveFailures: result.consecutiveFailures,
              suspended: result.suspended,
            },
            'Stuck job recovered',
          );

          // Publish audit event separately — failure here is non-fatal since the DB
          // mutation already committed. Log at error but do not treat as a recovery failure.
          try {
            const recoveredEvent = createScheduleRecovered({
              jobId: row.id,
              agentId: row.agent_id,
              runStartedAt: row.run_started_at,
              timeoutSeconds: row.timeout_seconds,
              consecutiveFailures: result.consecutiveFailures,
              suspended: result.suspended,
            });
            await this.bus.publish('system', recoveredEvent);
          } catch (publishErr) {
            this.logger.error({ publishErr, jobId: row.id }, 'Failed to publish schedule.recovered event — job was recovered in DB');
          }
        }
      } catch (err) {
        this.logger.error({ err, jobId: row.id }, 'Failed to recover stuck job — will retry on next watchdog tick');
      }
    }
  }
}
