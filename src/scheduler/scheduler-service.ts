import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createScheduleCreated } from '../bus/events.js';

// -- Public types --

export interface CreateJobParams {
  agentId: string;
  cronExpr?: string;
  runAt?: Date;
  taskPayload: Record<string, unknown>;
  createdBy: string;
  intentAnchor?: string;
  errorBudget?: Record<string, unknown>;
  /** IANA timezone for cron wall-clock interpretation. Defaults to the service's timezone. */
  timezone?: string;
  /** Expected duration of the job in seconds. Used to widen the delegate skill timeout for
   *  long-running jobs and to compute the watchdog recovery threshold. Must be a positive
   *  finite integer; non-integer, zero, negative, and non-finite values are rejected. */
  expectedDurationSeconds?: number;
}

export interface CreateJobResult {
  jobId: string;
  agentTaskId?: string;
}

/** Full job row with optional linked agent_task fields (from a LEFT JOIN). */
export interface JobRow {
  id: string;
  agentId: string;
  cronExpr: string | null;
  runAt: string | null;
  taskPayload: Record<string, unknown>;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: string;
  /** IANA timezone used for cron wall-clock interpretation. */
  timezone: string;
  // Linked agent_task fields (null when no task is linked)
  agentTaskId: string | null;
  intentAnchor: string | null;
  progress: Record<string, unknown> | null;
  runStartedAt: string | null;
  expectedDurationSeconds: number | null;
  lastRunOutcome: 'completed' | 'failed' | 'timed_out' | null;
  lastRunSummary: string | null;
  lastRunContext: Record<string, unknown> | null;
}

export interface ListJobsFilters {
  status?: string;
  agentId?: string;
}

// -- Internal DB row shape (snake_case) --

interface DbJobRow {
  id: string;
  agent_id: string;
  cron_expr: string | null;
  run_at: string | null;
  task_payload: Record<string, unknown>;
  status: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_by: string;
  created_at: string;
  timezone: string;
  agent_task_id: string | null;
  intent_anchor: string | null;
  progress: Record<string, unknown> | null;
  run_started_at: string | null;          // set when job enters 'running'; cleared on completion
  expected_duration_seconds: number | null; // per-job timeout hint; NULL → system default (600s)
  last_run_outcome: 'completed' | 'failed' | 'timed_out' | null;
  last_run_summary: string | null;   // agent-written summary; null until first scheduler-report call
  last_run_context: Record<string, unknown> | null; // opaque agent context; null until first scheduler-report call
}

// Threshold for auto-suspending jobs after consecutive failures.
const SUSPEND_THRESHOLD = 3;

export class SchedulerService {
  private pool: Pool;
  private bus: EventBus;
  private logger: Logger;
  /** Default IANA timezone for cron expression parsing when a job has no per-job timezone. */
  private timezone: string;

  constructor(pool: Pool, bus: EventBus, logger: Logger, timezone = 'UTC') {
    // Validate the timezone at construction time — an invalid zone name causes
    // cron-parser to throw opaque errors at runtime, and declarative jobs would
    // silently fail to load at startup with no clear root cause.
    const testDt = DateTime.local().setZone(timezone);
    if (!testDt.isValid) {
      throw new Error(`SchedulerService: invalid timezone "${timezone}" — check the TIMEZONE environment variable`);
    }
    this.pool = pool;
    this.bus = bus;
    this.logger = logger;
    this.timezone = timezone;
  }

  // -- Cron helpers --

  /**
   * Parse a cron expression and return the next run time as a Date.
   *
   * @param cronExpr  Standard 5-field cron expression
   * @param timezone  IANA timezone to use for wall-clock interpretation.
   *                  Defaults to the service's configured timezone so that
   *                  "0 8 * * *" fires at 8am local time, not 8am UTC.
   */
  nextRunFromCron(cronExpr: string, timezone?: string): Date {
    const tz = timezone ?? this.timezone;
    const expr = CronExpressionParser.parse(cronExpr, { tz });
    return expr.next().toDate();
  }

  /**
   * Validate that a cron expression doesn't fire more often than the minimum interval.
   * Prevents DoS via high-frequency cron jobs (e.g., every second or every minute).
   */
  validateCronFrequency(cronExpr: string, timezone?: string): void {
    const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const tz = timezone ?? this.timezone;
    const expr = CronExpressionParser.parse(cronExpr, { tz });
    const first = expr.next().toDate();
    const second = expr.next().toDate();
    const intervalMs = second.getTime() - first.getTime();
    if (intervalMs < MIN_INTERVAL_MS) {
      throw new Error(`Cron expression fires too frequently (every ${Math.round(intervalMs / 1000)}s). Minimum interval is 5 minutes.`);
    }
  }

  // -- CRUD --

  async createJob(params: CreateJobParams): Promise<CreateJobResult> {
    const { agentId, cronExpr, runAt, taskPayload, createdBy, intentAnchor, errorBudget } = params;
    // Per-job timezone: use caller's override, fall back to service default.
    // Validate LLM-supplied overrides — cron-parser accepts some invalid zone strings
    // (e.g. "UTC+99") without throwing, which would silently schedule jobs at wrong times.
    const rawJobTimezone = params.timezone ?? this.timezone;
    if (params.timezone !== undefined) {
      const tzCheck = DateTime.local().setZone(rawJobTimezone);
      if (!tzCheck.isValid) {
        throw new Error(`Invalid timezone "${rawJobTimezone}" — must be a valid IANA timezone name (e.g. "America/Toronto")`);
      }
    }
    const jobTimezone = rawJobTimezone;

    if (!cronExpr && !runAt) {
      throw new Error('Either cronExpr or runAt must be provided');
    }

    // Validate cron frequency to prevent DoS via high-frequency schedules.
    if (cronExpr) {
      this.validateCronFrequency(cronExpr, jobTimezone);
    }

    // Validate expectedDurationSeconds: must be a positive finite integer.
    // Reject invalid values explicitly so callers get a clear error rather than
    // silently falling back to the 10-minute watchdog default.
    const rawDuration = params.expectedDurationSeconds;
    if (rawDuration !== undefined) {
      if (!Number.isInteger(rawDuration) || rawDuration <= 0 || !Number.isFinite(rawDuration)) {
        throw new Error(`expectedDurationSeconds must be a positive finite integer, got: ${rawDuration}`);
      }
    }
    const hasExpectedDuration = rawDuration !== undefined;

    // Calculate next_run_at: for cron jobs use the parser (respecting per-job timezone),
    // for one-shot jobs use runAt directly (already UTC from timestamp normalization).
    const nextRunAt = cronExpr ? this.nextRunFromCron(cronExpr, jobTimezone) : runAt!;

    const insertSql = `
      INSERT INTO scheduled_jobs (agent_id, cron_expr, run_at, task_payload, status, next_run_at, created_by, timezone${hasExpectedDuration ? ', expected_duration_seconds' : ''})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8${hasExpectedDuration ? ', $9' : ''})
      RETURNING id
    `;
    const insertParams: unknown[] = [
      agentId,
      cronExpr ?? null,
      runAt ?? null,
      JSON.stringify(taskPayload),
      'pending',
      nextRunAt,
      createdBy,
      jobTimezone,
    ];
    if (hasExpectedDuration) {
      insertParams.push(rawDuration);
    }

    const { rows } = await this.pool.query(insertSql, insertParams);
    const jobId = (rows[0] as { id: string }).id;

    // If an intentAnchor is provided, create a linked agent_task for persistent state tracking.
    let agentTaskId: string | undefined;
    if (intentAnchor) {
      const taskSql = `
        INSERT INTO agent_tasks (agent_id, intent_anchor, status, error_budget, scheduled_job_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `;
      const taskParams = [
        agentId,
        intentAnchor,
        'active',
        JSON.stringify(errorBudget ?? {}),
        jobId,
      ];
      const taskResult = await this.pool.query(taskSql, taskParams);
      agentTaskId = (taskResult.rows[0] as { id: string }).id;
    }

    // Publish schedule.created event for audit trail.
    const event = createScheduleCreated({
      jobId,
      agentId,
      cronExpr: cronExpr ?? null,
      runAt: runAt?.toISOString() ?? null,
      taskPayload,
      createdBy,
    });
    await this.bus.publish('system', event);

    this.logger.info({ jobId, agentId, cronExpr, agentTaskId }, 'Scheduled job created');

    return { jobId, agentTaskId };
  }

  async getJob(jobId: string): Promise<JobRow | null> {
    const sql = `
      SELECT sj.*,
             at.id AS agent_task_id,
             at.intent_anchor,
             at.progress
        FROM scheduled_jobs sj
        LEFT JOIN agent_tasks at ON at.scheduled_job_id = sj.id
       WHERE sj.id = $1
    `;
    const { rows } = await this.pool.query(sql, [jobId]);
    const row = rows[0] as DbJobRow | undefined;
    if (!row) return null;
    return mapJobRow(row);
  }

  async listJobs(filters?: ListJobsFilters): Promise<JobRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters?.status) {
      conditions.push(`sj.status = $${paramIndex}`);
      params.push(filters.status);
      paramIndex++;
    }

    if (filters?.agentId) {
      conditions.push(`sj.agent_id = $${paramIndex}`);
      params.push(filters.agentId);
      paramIndex++;
    }

    // Suppress unused-variable warning — paramIndex is incremented to stay ready for future filters.
    void paramIndex;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT sj.*,
             at.id AS agent_task_id,
             at.intent_anchor,
             at.progress
        FROM scheduled_jobs sj
        LEFT JOIN agent_tasks at ON at.scheduled_job_id = sj.id
       ${whereClause}
       ORDER BY sj.created_at DESC
    `;
    const { rows } = await this.pool.query(sql, params);
    return (rows as DbJobRow[]).map(mapJobRow);
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_jobs SET status = $1 WHERE id = $2`,
      ['cancelled', jobId],
    );
    // Also cancel linked agent_task if any
    await this.pool.query(
      `UPDATE agent_tasks SET status = 'cancelled', updated_at = now() WHERE scheduled_job_id = $1`,
      [jobId],
    );
    this.logger.info({ jobId }, 'Scheduled job cancelled');
  }

  /**
   * Pause a job and its linked agent_task due to intent drift detection.
   * Sets status = 'paused' on both tables in a single query.
   * The CEO must review and resume or cancel the job manually.
   */
  async pauseJobForDrift(jobId: string): Promise<void> {
    // Update both tables atomically: pause the job and its linked agent_task.
    // Uses a CTE so both updates happen in one round-trip and stay consistent.
    await this.pool.query(
      `WITH paused_job AS (
         UPDATE scheduled_jobs
            SET status = 'paused'
          WHERE id = $1
       )
       UPDATE agent_tasks
          SET status     = 'paused',
              updated_at = now()
        WHERE scheduled_job_id = $1`,
      [jobId],
    );

    this.logger.info({ jobId }, 'Job paused due to intent drift detection');
  }

  async unsuspendJob(jobId: string): Promise<void> {
    // Fetch the job to get cron_expr or run_at for recalculating next_run_at
    const { rows } = await this.pool.query(
      `SELECT cron_expr, run_at, timezone FROM scheduled_jobs WHERE id = $1 AND status = 'suspended'`,
      [jobId],
    );
    if (rows.length === 0) {
      throw new Error(`Job ${jobId} not found or not suspended`);
    }

    const { cron_expr, run_at, timezone: jobTimezone } = rows[0] as { cron_expr: string | null; run_at: Date | null; timezone: string };
    let nextRunAt: Date;
    if (cron_expr) {
      // Use the per-job timezone so the next run fires at the correct wall-clock time.
      nextRunAt = this.nextRunFromCron(cron_expr, jobTimezone);
    } else {
      // One-shot job: re-use original run_at (may be in the past — will fire immediately)
      nextRunAt = new Date(run_at!);
    }

    await this.pool.query(
      `UPDATE scheduled_jobs
         SET status = 'pending',
             consecutive_failures = 0,
             last_error = NULL,
             next_run_at = $2
       WHERE id = $1`,
      [jobId, nextRunAt],
    );
    this.logger.info({ jobId }, 'Scheduled job unsuspended');
  }

  async updateJob(
    jobId: string,
    updates: { cronExpr?: string; runAt?: Date; taskPayload?: Record<string, unknown> },
  ): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.cronExpr !== undefined) {
      // Validate frequency before accepting the update.
      this.validateCronFrequency(updates.cronExpr);

      setClauses.push(`cron_expr = $${paramIndex}`);
      params.push(updates.cronExpr);
      paramIndex++;

      // Recalculate next_run_at when the cron expression changes.
      const nextRun = this.nextRunFromCron(updates.cronExpr);
      setClauses.push(`next_run_at = $${paramIndex}`);
      params.push(nextRun);
      paramIndex++;
    }

    if (updates.runAt !== undefined) {
      setClauses.push(`run_at = $${paramIndex}`);
      params.push(updates.runAt);
      paramIndex++;

      setClauses.push(`next_run_at = $${paramIndex}`);
      params.push(updates.runAt);
      paramIndex++;
    }

    if (updates.taskPayload !== undefined) {
      setClauses.push(`task_payload = $${paramIndex}`);
      params.push(JSON.stringify(updates.taskPayload));
      paramIndex++;
    }

    // Suppress unused-variable warning
    void paramIndex;

    if (setClauses.length === 0) return;

    params.push(jobId);
    const sql = `UPDATE scheduled_jobs SET ${setClauses.join(', ')} WHERE id = $${params.length}`;
    await this.pool.query(sql, params);

    this.logger.info({ jobId, updates: Object.keys(updates) }, 'Scheduled job updated');
  }

  /**
   * Upsert a declarative job (system-created, idempotent on restart).
   * Uses ON CONFLICT with the column list matching the partial unique index
   * scheduled_jobs_declarative_uq (agent_id, cron_expr, task_payload::text WHERE created_by = 'system').
   * Note: ON CONFLICT ON CONSTRAINT only works with named CONSTRAINTS, not named indexes —
   * so we use the column-based syntax here to match the CREATE UNIQUE INDEX definition.
   */
  async upsertDeclarativeJob(
    agentId: string,
    schedule: { cron: string; task: string; expectedDurationSeconds?: number },
  ): Promise<string> {
    const taskPayload = { task: schedule.task };
    const nextRunAt = this.nextRunFromCron(schedule.cron);

    // Validate expectedDurationSeconds: must be a finite positive integer.
    // Invalid values fall back to absent (NULL in DB) so the watchdog default applies.
    // Unlike createJob() which throws, startup must not abort for a misconfigured hint —
    // but we warn loudly so operators can identify and fix the YAML config.
    const rawDuration = schedule.expectedDurationSeconds;
    const validDuration =
      rawDuration !== undefined &&
      Number.isInteger(rawDuration) &&
      rawDuration > 0 &&
      Number.isFinite(rawDuration);

    if (rawDuration !== undefined && !validDuration) {
      this.logger.warn(
        { agentId, cron: schedule.cron, expectedDurationSeconds: rawDuration },
        'upsertDeclarativeJob: expectedDurationSeconds is invalid (must be a positive finite integer) — falling back to system default watchdog threshold; check the agent YAML config',
      );
    }

    // NULL when absent or invalid — always written to DO UPDATE so that removing
    // expectedDurationSeconds from the YAML clears the stale DB value on the next restart,
    // rather than leaving a now-wrong watchdog threshold silently in place.
    const durationToWrite = validDuration ? rawDuration : null;

    // Include timezone so completeJobRun() re-advances next_run_at in the same zone.
    // Without this, the DB column would default to 'UTC' while next_run_at was computed
    // using this.timezone — causing every post-completion firing to be offset by the UTC delta.
    // expected_duration_seconds is always included (as $8) so the DO UPDATE can clear it to NULL
    // when the field is removed from the YAML — the conditional-column pattern would leave a
    // stale value in place.
    const sql = `
      INSERT INTO scheduled_jobs (agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone, expected_duration_seconds)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (agent_id, cron_expr, (task_payload::text)) WHERE created_by = 'system'
      DO UPDATE SET next_run_at = $5,
                    timezone = $7,
                    expected_duration_seconds = $8
      RETURNING id
    `;
    const params: unknown[] = [
      agentId,
      schedule.cron,
      JSON.stringify(taskPayload),
      'pending',
      nextRunAt,
      'system',
      this.timezone,
      durationToWrite,
    ];

    const { rows } = await this.pool.query(sql, params);
    return (rows[0] as { id: string }).id;
  }

  /**
   * Complete a job run.
   * - On success: if recurring (has cron_expr), advance next_run_at and reset failures;
   *   if one-shot, mark as completed.
   * - On failure: increment consecutive_failures. If it reaches SUSPEND_THRESHOLD, auto-suspend.
   */
  async completeJobRun(
    jobId: string,
    success: boolean,
    error?: string,
  ): Promise<{ suspended: boolean }> {
    // Fetch the current job state to decide how to handle the completion.
    // Include timezone so nextRunFromCron() uses the per-job zone, not the system default.
    // NOTE: this query requires migration 012 (adds the timezone column). If it has not been
    // applied, pg will throw "column timezone does not exist", handleCompletion() will catch it
    // and log an error, and the job will be left permanently in 'running' state with no recovery.
    // Always run migrations before deploying code that depends on them.
    const fetchSql = `SELECT id, cron_expr, status, consecutive_failures, timezone FROM scheduled_jobs WHERE id = $1`;
    const { rows } = await this.pool.query(fetchSql, [jobId]);
    const job = rows[0] as { id: string; cron_expr: string | null; status: string; consecutive_failures: number; timezone: string } | undefined;

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (success) {
      if (job.cron_expr) {
        // Recurring job: advance to next run using the per-job timezone, reset failure counter.
        const nextRunAt = this.nextRunFromCron(job.cron_expr, job.timezone);
        const updateSql = `
          UPDATE scheduled_jobs
             SET last_run_at = now(),
                 next_run_at = $1,
                 consecutive_failures = 0,
                 last_error = NULL,
                 run_started_at = NULL,
                 status = $2,
                 last_run_outcome = $4
           WHERE id = $3
        `;
        await this.pool.query(updateSql, [nextRunAt, 'pending', jobId, 'completed']);
      } else {
        // One-shot job: mark as completed.
        const updateSql = `
          UPDATE scheduled_jobs
             SET last_run_at = now(),
                 status = $1,
                 consecutive_failures = 0,
                 last_error = NULL,
                 run_started_at = NULL,
                 last_run_outcome = $3
           WHERE id = $2
        `;
        await this.pool.query(updateSql, ['completed', jobId, 'completed']);
      }

      this.logger.info({ jobId }, 'Job run completed successfully');
      return { suspended: false };
    }

    // Failure path: increment consecutive_failures and possibly auto-suspend.
    const newFailures = job.consecutive_failures + 1;
    const shouldSuspend = newFailures >= SUSPEND_THRESHOLD;
    const newStatus = shouldSuspend ? 'suspended' : 'failed';

    const updateSql = `
      UPDATE scheduled_jobs
         SET last_run_at = now(),
             consecutive_failures = $1,
             last_error = $2,
             run_started_at = NULL,
             status = $3,
             last_run_outcome = $5
       WHERE id = $4
    `;
    await this.pool.query(updateSql, [newFailures, error ?? null, newStatus, jobId, 'failed']);

    if (shouldSuspend) {
      this.logger.warn({ jobId, consecutiveFailures: newFailures }, 'Job auto-suspended after consecutive failures');
    } else {
      this.logger.info({ jobId, consecutiveFailures: newFailures, error }, 'Job run failed');
    }

    return { suspended: shouldSuspend };
  }

  /**
   * Recover a single stuck job: increment failures, reset status to pending (or suspend),
   * clear run_started_at, advance next_run_at, and write a descriptive last_error.
   *
   * Called by Scheduler.recoverStuckJobs() for each job that has exceeded its timeout.
   */
  async recoverStuckJob(
    jobId: string,
    timeoutSeconds: number,
  ): Promise<{ noOp: boolean; suspended: boolean; consecutiveFailures: number }> {
    const { rows } = await this.pool.query(
      `SELECT id, cron_expr, run_at, consecutive_failures, timezone
         FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    const job = rows[0] as {
      id: string;
      cron_expr: string | null;
      run_at: string | null;
      consecutive_failures: number;
      timezone: string;
    } | undefined;

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const newFailures = job.consecutive_failures + 1;
    const shouldSuspend = newFailures >= SUSPEND_THRESHOLD;
    const newStatus = shouldSuspend ? 'suspended' : 'pending';

    // For recurring jobs: advance to the next valid fire time so the job doesn't
    // attempt to catch up on missed slots. For one-shot jobs: re-fire immediately.
    const nextRunAt = job.cron_expr
      ? this.nextRunFromCron(job.cron_expr, job.timezone)
      : new Date();

    const timeoutMinutes = Math.round(timeoutSeconds / 60);
    const lastError = `Job timed out after ${timeoutMinutes}m — auto-recovered`;

    // Guard against a race where the job completed normally between our SELECT above
    // and this UPDATE. The AND status = 'running' check ensures we only overwrite jobs
    // that are still genuinely stuck — if rowCount is 0, the job already finished cleanly.
    const result = await this.pool.query(
      `UPDATE scheduled_jobs
          SET status = $1,
              consecutive_failures = $2,
              last_error = $3,
              run_started_at = NULL,
              next_run_at = $4,
              last_run_outcome = $6
        WHERE id = $5
          AND status = 'running'`,
      [newStatus, newFailures, lastError, nextRunAt, jobId, 'timed_out'],
    );

    if (result.rowCount === 0) {
      // The job completed normally between our SELECT and this UPDATE — no recovery needed.
      this.logger.debug({ jobId }, 'recoverStuckJob: job completed before recovery ran — no-op');
      return { noOp: true, suspended: false, consecutiveFailures: 0 };
    }

    if (shouldSuspend) {
      this.logger.warn({ jobId, consecutiveFailures: newFailures }, 'Stuck job suspended after consecutive recovery failures');
    } else {
      this.logger.warn({ jobId, consecutiveFailures: newFailures, timeoutMinutes }, 'Stuck job recovered — reset to pending');
    }

    return { noOp: false, suspended: shouldSuspend, consecutiveFailures: newFailures };
  }

  /**
   * Write an agent-authored summary and optional structured context to the job's
   * last-run record. Called by the scheduler-report skill at the end of each job
   * execution so operators and agents can inspect what happened without trawling logs.
   *
   * @param jobId    The job to update.
   * @param summary  Human-readable description of what the run accomplished.
   * @param context  Optional opaque structured data (e.g. counts, entity IDs, errors).
   */
  async reportJobRun(
    jobId: string,
    summary: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    let result: { rowCount: number | null };

    if (context !== undefined) {
      result = await this.pool.query(
        `UPDATE scheduled_jobs
            SET last_run_summary = $1,
                last_run_context = $2
          WHERE id = $3`,
        [summary, JSON.stringify(context), jobId],
      );
    } else {
      result = await this.pool.query(
        `UPDATE scheduled_jobs
            SET last_run_summary = $1
          WHERE id = $2`,
        [summary, jobId],
      );
    }

    if (!result.rowCount) {
      throw new Error(`reportJobRun: no job found with id "${jobId}" — report not written`);
    }

    this.logger.info({ jobId }, 'scheduler-report written');
  }
}

// -- Row mapping --

/** Convert a snake_case DB row to the camelCase JobRow type. */
function mapJobRow(row: DbJobRow): JobRow {
  return {
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
    timezone: row.timezone,
    agentTaskId: row.agent_task_id,
    intentAnchor: row.intent_anchor ?? null,
    progress: row.progress,
    runStartedAt: row.run_started_at,
    expectedDurationSeconds: row.expected_duration_seconds,
    lastRunOutcome: row.last_run_outcome,
    lastRunSummary: row.last_run_summary,
    lastRunContext: row.last_run_context,
  };
}
