import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createScheduleCreated } from '../bus/events.js';
import type { TaskOriginator } from '../contacts/types.js';
import { makeSystemOriginator } from '../contacts/principal.js';

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
  /** Who originally initiated the task chain that created this schedule entry.
   *  Preserved in the DB so fireJob() can stamp it on the resulting agent.task,
   *  allowing isPrincipalOriginated() to return true for principal-authorized scheduled work.
   *  Null for pre-040 rows, or when a job is created without an originator.
   *  Declarative jobs use systemRole: 'system'. */
  originator?: TaskOriginator;
}

export interface CreateJobResult {
  jobId: string;
  agentTaskId?: string;
}

/** Full job row with optional linked task fields (from a LEFT JOIN on tasks). */
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
  // Linked task fields (null when no task is linked via scheduled_jobs.task_id)
  agentTaskId: string | null;
  intentAnchor: string | null;
  progress: Record<string, unknown> | null;
  /** Human-readable task title — included in the content bundle so receiving agents have context. */
  taskTitle: string | null;
  runStartedAt: string | null;
  expectedDurationSeconds: number | null;
  lastRunOutcome: 'completed' | 'failed' | 'timed_out' | null;
  lastRunSummary: string | null;
  lastRunContext: Record<string, unknown> | null;
  /** TaskOriginator stored at schedule-creation time. Null for pre-040 rows or rows
   *  created without an originator. Declarative jobs use systemRole: 'system'. Stamped on
   *  the resulting agent.task by fireJob(). */
  originator: TaskOriginator | null;
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
  task_title: string | null;
  run_started_at: string | null;          // set when job enters 'running'; cleared on completion
  expected_duration_seconds: number | null; // per-job timeout hint; NULL → system default (600s)
  last_run_outcome: 'completed' | 'failed' | 'timed_out' | null;
  last_run_summary: string | null;   // agent-written summary; null until first scheduler-report call
  last_run_context: Record<string, unknown> | null; // opaque agent context; null until first scheduler-report call
  originator: Record<string, unknown> | null; // JSONB — cast to TaskOriginator when mapping
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

    // originator is always written — null for non-principal-initiated jobs. Always including
    // it (rather than conditionally) keeps the SQL simpler and matches the nullable column.
    const insertSql = `
      INSERT INTO scheduled_jobs (agent_id, cron_expr, run_at, task_payload, status, next_run_at, created_by, timezone, originator${hasExpectedDuration ? ', expected_duration_seconds' : ''})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${hasExpectedDuration ? ', $10' : ''})
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
      // Serialize as JSON string for pg JSONB — null when no originator was provided.
      params.originator ? JSON.stringify(params.originator) : null,
    ];
    if (hasExpectedDuration) {
      insertParams.push(rawDuration);
    }

    const { rows } = await this.pool.query(insertSql, insertParams);
    const jobId = (rows[0] as { id: string }).id;

    // If an intentAnchor is provided, create a linked task row and bind it to the job.
    // The FK direction is scheduled_jobs.task_id → tasks.id, so we INSERT the task
    // first and then UPDATE the job row with the new task's id.
    //
    // The CTE surfaces both the task id and the job id from the UPDATE so that a
    // silent UPDATE failure (scheduled_jobs row disappeared in a race) is detectable —
    // link_job with 0 matched rows returns job_id=null via the LEFT JOIN.
    let agentTaskId: string | undefined;
    if (intentAnchor) {
      const taskSql = `
        WITH new_task AS (
          INSERT INTO tasks (agent_id, title, intent_anchor, status, error_budget, source_agent_id)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          RETURNING id
        ),
        link_job AS (
          UPDATE scheduled_jobs SET task_id = new_task.id
            FROM new_task
           WHERE scheduled_jobs.id = $7
          RETURNING scheduled_jobs.id AS job_id
        )
        SELECT new_task.id AS task_id, link_job.job_id
          FROM new_task
          LEFT JOIN link_job ON true
      `;
      const taskParams = [
        agentId,
        intentAnchor,   // use intentAnchor as the task title
        intentAnchor,
        'active',
        JSON.stringify(errorBudget ?? {}),
        agentId,        // source_agent_id
        jobId,
      ];
      const taskResult = await this.pool.query(taskSql, taskParams);
      const taskRow = taskResult.rows[0] as { task_id: string; job_id: string | null } | undefined;
      if (!taskRow?.task_id) {
        throw new Error(`createJob: INSERT into tasks returned no row for job ${jobId}`);
      }
      if (!taskRow.job_id) {
        // The INSERT succeeded but the UPDATE found no scheduled_jobs row.
        // This means a concurrent cancel removed the job between the INSERT above and this CTE.
        this.logger.error(
          { agentId, jobId, taskId: taskRow.task_id },
          'createJob: task row created but scheduled_jobs.task_id link failed — orphaned task',
        );
        throw new Error(`createJob: scheduled_jobs row ${jobId} not found when linking task`);
      }
      agentTaskId = taskRow.task_id;
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
             t.id AS agent_task_id,
             t.intent_anchor,
             t.progress,
             t.title AS task_title
        FROM scheduled_jobs sj
        LEFT JOIN tasks t ON sj.task_id = t.id
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
             t.id AS agent_task_id,
             t.intent_anchor,
             t.progress,
             t.title AS task_title
        FROM scheduled_jobs sj
        LEFT JOIN tasks t ON sj.task_id = t.id
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
    // Also cancel the linked task if any (FK is now on scheduled_jobs.task_id → tasks.id).
    await this.pool.query(
      `UPDATE tasks t
          SET status = 'cancelled', updated_at = now()
         FROM scheduled_jobs sj
        WHERE sj.id = $1 AND t.id = sj.task_id`,
      [jobId],
    );
    this.logger.info({ jobId }, 'Scheduled job cancelled');
  }

  /**
   * Pause a job and its linked task due to intent drift detection.
   * Sets status = 'paused' on both tables in a single query.
   * The CEO must review and resume or cancel the job manually.
   */
  async pauseJobForDrift(jobId: string): Promise<void> {
    // Update both tables atomically: pause the job and its linked task.
    // Uses a CTE so both updates happen in one round-trip and stay consistent.
    // The FK is now scheduled_jobs.task_id → tasks.id, so we join through scheduled_jobs.
    await this.pool.query(
      `WITH paused_job AS (
         UPDATE scheduled_jobs
            SET status = 'paused'
          WHERE id = $1
       )
       UPDATE tasks t
          SET status     = 'paused',
              updated_at = now()
         FROM scheduled_jobs sj
        WHERE sj.id = $1 AND t.id = sj.task_id`,
      [jobId],
    );

    this.logger.info({ jobId }, 'Job paused due to intent drift detection');
  }

  async unsuspendJob(jobId: string): Promise<void> {
    // Accept both 'suspended' (failure-threshold path) and 'paused' (drift-detection path) —
    // both are operator-hold states that the resume endpoint should release.
    const { rows } = await this.pool.query(
      `SELECT cron_expr, run_at, timezone FROM scheduled_jobs WHERE id = $1 AND status IN ('suspended', 'paused')`,
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

    // Also resume any tasks that were paused by the drift-detection path.
    // Suspended jobs (failure-threshold path) don't set tasks.status, so this
    // UPDATE is a no-op for them — it only affects drift-paused jobs.
    await this.pool.query(
      `UPDATE tasks t
          SET status = 'active', updated_at = now()
         FROM scheduled_jobs sj
        WHERE sj.id = $1 AND t.id = sj.task_id AND t.status = 'paused'`,
      [jobId],
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
   * scheduled_jobs_declarative_uq
   * (source_agent_id, agent_id, cron_expr, task_payload::text WHERE created_by = 'system').
   * Note: ON CONFLICT ON CONSTRAINT only works with named CONSTRAINTS, not named indexes —
   * so we use the column-based syntax here to match the CREATE UNIQUE INDEX definition.
   *
   * When schedule.intent_anchor is present, also creates a linked tasks row so the
   * drift detector can fire for this job. The INSERT is guarded by WHERE NOT EXISTS to
   * preserve the existing task row (and its accumulated progress) across restarts.
   * The FK direction is scheduled_jobs.task_id → tasks.id, so after inserting the task
   * we UPDATE scheduled_jobs.task_id. Both operations are in one CTE for atomicity.
   */
  async upsertDeclarativeJob(
    sourceAgentId: string,
    agentId: string,
    schedule: { cron: string; task: string; expectedDurationSeconds?: number; intent_anchor?: string },
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
        { sourceAgentId, agentId, cron: schedule.cron, expectedDurationSeconds: rawDuration },
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
    // Stamp a system originator so declarative jobs have non-null originator in the DB.
    // systemRole: 'system' distinguishes operator-configured work from principal-initiated
    // ('principal') and agent-decided ('agent') tasks. See issue #558.
    const originator = makeSystemOriginator();

    // The `prior` CTE captures the row's state BEFORE the upsert (it reads the
    // statement-start snapshot), so we can tell a routine refresh apart from a
    // revival of a previously-cancelled row and log the latter loudly below.
    // The payload predicate mirrors the ON CONFLICT key: task_payload::text is the
    // stored jsonb canonical text, and $4::jsonb::text normalizes the incoming
    // payload the same way, so this matches exactly the row ON CONFLICT will hit.
    const sql = `
      WITH prior AS (
        SELECT status AS prior_status,
               consecutive_failures AS prior_failures,
               last_error AS prior_error
          FROM scheduled_jobs
         WHERE created_by = 'system'
           AND source_agent_id = $1
           AND agent_id = $2
           AND cron_expr = $3
           AND task_payload::text = $4::jsonb::text
      )
      INSERT INTO scheduled_jobs (source_agent_id, agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone, expected_duration_seconds, originator)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (source_agent_id, agent_id, cron_expr, (task_payload::text)) WHERE created_by = 'system'
      DO UPDATE SET next_run_at = $6,
                    timezone = $8,
                    expected_duration_seconds = $9,
                    originator = COALESCE(scheduled_jobs.originator, $10),
                    -- Revive a row that a prior stale-cleanup cancelled but whose YAML
                    -- declaration still exists. Without this, the ON CONFLICT path updates
                    -- the row in place and leaves status = 'cancelled' forever, so a still-
                    -- declared job silently never runs again after one bad cancellation
                    -- (e.g. the historical task_payload-normalization mismatch). Revive ONLY
                    -- 'cancelled'; 'running', 'suspended' (failure threshold), 'paused' (drift),
                    -- 'pending', 'failed' and 'completed' are left untouched.
                    --
                    -- Consequence: a deliberate cancelJob() on a still-declared declarative job
                    -- is NOT durable across restart — it lands in 'cancelled' and is revived
                    -- here. The supported way to permanently stop a declarative job is to remove
                    -- its schedule entry from the agent YAML; the row then has no re-declaring
                    -- upsert, so cancelStaleDeclarativeJobs cancels it and it stays cancelled.
                    -- Revivals are logged at warn level below so the override is visible.
                    --
                    -- Reviving also clears the stale failure bookkeeping so the job starts from
                    -- a clean slate; the wiped values are preserved in the revival log line.
                    status = CASE WHEN scheduled_jobs.status = 'cancelled' THEN 'pending' ELSE scheduled_jobs.status END,
                    consecutive_failures = CASE WHEN scheduled_jobs.status = 'cancelled' THEN 0 ELSE scheduled_jobs.consecutive_failures END,
                    last_error = CASE WHEN scheduled_jobs.status = 'cancelled' THEN NULL ELSE scheduled_jobs.last_error END
      RETURNING id,
                (SELECT prior_status FROM prior) AS prior_status,
                (SELECT prior_failures FROM prior) AS prior_failures,
                (SELECT prior_error FROM prior) AS prior_error
    `;
    const params: unknown[] = [
      sourceAgentId,
      agentId,
      schedule.cron,
      JSON.stringify(taskPayload),
      'pending',
      nextRunAt,
      'system',
      this.timezone,
      durationToWrite,
      JSON.stringify(originator),
    ];

    const { rows } = await this.pool.query(sql, params);
    const resultRow = rows[0] as {
      id: string;
      prior_status?: string | null;
      prior_failures?: number | null;
      prior_error?: string | null;
    };
    const jobId = resultRow.id;

    // Reviving overrides a terminal 'cancelled' state, so surface it loudly — the
    // symmetric cancellation path (cancelStaleDeclarativeJobs) logs per row, and a
    // resurrection must be at least as visible. Include the failure bookkeeping the
    // upsert just wiped so the prior context survives in the logs. warn (not info)
    // because this silently undoes a deliberate cancelJob() if one was issued.
    if (resultRow.prior_status === 'cancelled') {
      this.logger.warn(
        {
          jobId,
          sourceAgentId,
          agentId,
          cron: schedule.cron,
          priorConsecutiveFailures: resultRow.prior_failures ?? null,
          priorLastError: resultRow.prior_error ?? null,
        },
        'Declarative job revived from cancelled — its YAML declaration still exists. ' +
          'If this job was deliberately stopped, remove its schedule entry from the agent YAML instead of cancelling it.',
      );
    }

    // If intent_anchor is set, create a linked tasks row so the drift detector can
    // fire for this job — same pattern as createJob(). The WHERE NOT EXISTS guard ensures
    // this is a no-op on restart (preserving accumulated progress in the existing row).
    //
    // The CTE surfaces both outcomes via a SELECT at the end:
    //   - rows = [] (empty): WHERE NOT EXISTS fired — existing task preserved (idempotent)
    //   - rows = [{ task_id, job_id }]: new task created and job linked
    //   - rows = [{ task_id, job_id: null }]: INSERT succeeded but link_job UPDATE returned
    //     no rows — either the job was deleted concurrently, or a parallel startup already
    //     set task_id (AND task_id IS NULL guard prevents overwriting). The cleanup_orphan
    //     CTE deletes the just-inserted task so no orphan accumulates; treated as a hard error.
    if (schedule.intent_anchor) {
      const taskSql = `
        WITH new_task AS (
          INSERT INTO tasks (agent_id, title, intent_anchor, status, error_budget, source_agent_id)
          SELECT $1, $2, $3, $4, $5::jsonb, $6
          WHERE NOT EXISTS (SELECT 1 FROM scheduled_jobs WHERE id = $7 AND task_id IS NOT NULL)
          RETURNING id
        ),
        link_job AS (
          UPDATE scheduled_jobs
             SET task_id = new_task.id
            FROM new_task
           WHERE scheduled_jobs.id = $7
             AND task_id IS NULL
          RETURNING scheduled_jobs.id AS job_id
        ),
        cleanup_orphan AS (
          DELETE FROM tasks
           WHERE id = (SELECT id FROM new_task)
             AND NOT EXISTS (SELECT 1 FROM link_job)
        )
        SELECT new_task.id AS task_id, link_job.job_id
          FROM new_task
          LEFT JOIN link_job ON true
      `;
      let taskResult: { rows: unknown[] };
      try {
        taskResult = await this.pool.query(taskSql, [
          agentId,
          schedule.intent_anchor,   // title
          schedule.intent_anchor,   // intent_anchor
          'active',
          JSON.stringify({}),
          agentId,                  // source_agent_id
          jobId,
        ]);
      } catch (err) {
        // Re-throw so loadDeclarativeJobs treats the whole upsert as failed.
        // The scheduled_jobs row was already written, but without the tasks
        // link the drift detector cannot fire — running silently in a degraded state
        // is worse than a loud failure that prompts operator attention.
        this.logger.error(
          { err, agentId, jobId, intentAnchor: schedule.intent_anchor },
          'upsertDeclarativeJob: failed to create tasks row — job will run without drift detection until this is resolved',
        );
        throw err;
      }
      const resultRow = taskResult.rows[0] as { task_id: string; job_id: string | null } | undefined;
      if (resultRow && !resultRow.job_id) {
        // INSERT succeeded but the UPDATE found no scheduled_jobs row.
        // This is a race: the job was cancelled between the upsert above and this CTE.
        this.logger.error(
          { agentId, jobId, intentAnchor: schedule.intent_anchor, taskId: resultRow.task_id },
          'upsertDeclarativeJob: tasks row created but scheduled_jobs.task_id link failed — orphaned task',
        );
        throw new Error(`upsertDeclarativeJob: scheduled_jobs row ${jobId} not found when linking task`);
      }
      const anchorCreated = resultRow != null;
      this.logger.info(
        { agentId, jobId, intentAnchor: schedule.intent_anchor, anchorCreated },
        anchorCreated
          ? 'upsertDeclarativeJob: tasks row created for intent_anchor (drift detection enabled)'
          : 'upsertDeclarativeJob: tasks row already exists — skipped (restart idempotency)',
      );
    }

    return jobId;
  }

  /**
   * Cancel stale declarative (system-created) jobs that are no longer declared in YAML.
   *
   * After all upsertDeclarativeJob() calls complete, the caller passes the full set of
   * (agent_id, cron_expr, task_payload::text) tuples that were successfully upserted.
   * Any system-created rows in 'pending' or 'failed' status whose triple is NOT in that
   * set are stale — their cron changed, or the entry was removed from YAML entirely.
   *
   * Running and suspended jobs are left alone: running jobs are handled by the watchdog,
   * and suspended jobs may have been paused intentionally by an operator.
   *
   * Returns the number of rows cancelled.
   */
  async cancelStaleDeclarativeJobs(
    liveTuples: Array<{ sourceAgentId: string; agentId: string; cronExpr: string; taskPayload: string }>,
  ): Promise<number> {
    // Build a parameterized exclusion clause. Each live tuple becomes a
    // (source_agent_id, agent_id, cron_expr, task_payload::text) tuple in a VALUES list so
    // the NOT IN check is a single set operation — no per-tuple subqueries.
    //
    // When there are zero live tuples, every system row is stale (all schedules
    // were removed). The empty exclusion clause correctly targets all system rows.
    const valuePlaceholders: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const tuple of liveTuples) {
      // Cast the payload parameter to ::jsonb::text so PostgreSQL normalizes it
      // (sorts object keys, strips whitespace) before comparing. This ensures
      // both sides of the NOT IN check go through the same JSONB serializer —
      // matching how the unique index (task_payload::text) is computed. Without
      // the cast, a multi-key payload could diverge between JS JSON.stringify
      // key order and PostgreSQL's canonical key order, silently failing to
      // shield a live job from cancellation.
      valuePlaceholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}::jsonb::text)`);
      params.push(tuple.sourceAgentId, tuple.agentId, tuple.cronExpr, tuple.taskPayload);
      idx += 4;
    }

    // When liveTuples is non-empty, exclude the live set. When empty, no exclusion
    // is needed — the UPDATE targets all system rows with pending/failed status.
    const exclusionClause = valuePlaceholders.length > 0
      ? `AND (source_agent_id, agent_id, cron_expr, task_payload::text) NOT IN (VALUES ${valuePlaceholders.join(', ')})`
      : '';

    const sql = `
      UPDATE scheduled_jobs
         SET status = 'cancelled'
       WHERE created_by = 'system'
         AND status IN ('pending', 'failed')
         ${exclusionClause}
      RETURNING id, agent_id, cron_expr, task_payload
    `;

    const { rows } = await this.pool.query(sql, params);

    for (const row of rows as Array<{ id: string; agent_id: string; cron_expr: string; task_payload: unknown }>) {
      this.logger.info(
        { jobId: row.id, agentId: row.agent_id, cronExpr: row.cron_expr, action: 'cancelled' },
        'Stale declarative job cancelled — schedule entry changed or removed from YAML',
      );
    }

    // TODO: this method only cancels scheduled_jobs rows. When a stale declarative schedule has
    // an intent_anchor, upsertDeclarativeJob creates a linked tasks row (via scheduled_jobs.task_id).
    // Cancelling the scheduled_jobs row here leaves that tasks row in 'active' status with no job
    // pointing at it. When agent YAML schedules start using intent_anchor, add a mirror cleanup here
    // (UPDATE tasks SET status='cancelled' WHERE id IN (SELECT task_id FROM ... cancelled rows))
    // to match the cancelJob() pattern. No agent YAML schedule entries use intent_anchor today,
    // so this is safe to defer until they do.
    return rows.length;
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
    autoSummary?: string,
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
                 last_run_outcome = $4,
                 last_run_summary = COALESCE(last_run_summary, $5)
           WHERE id = $3
        `;
        await this.pool.query(updateSql, [nextRunAt, 'pending', jobId, 'completed', autoSummary ?? null]);
      } else {
        // One-shot job: mark as completed.
        const updateSql = `
          UPDATE scheduled_jobs
             SET last_run_at = now(),
                 status = $1,
                 consecutive_failures = 0,
                 last_error = NULL,
                 run_started_at = NULL,
                 last_run_outcome = $3,
                 last_run_summary = COALESCE(last_run_summary, $4)
           WHERE id = $2
        `;
        await this.pool.query(updateSql, ['completed', jobId, 'completed', autoSummary ?? null]);
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

  /** Enqueue a one-shot wake for an EXISTING task. Inserts a pending scheduled_jobs
   *  row with task_id preset so the dispatcher routes it to `agentId` with full task
   *  context. Used by the BacklogHeartbeat. Does not create a new task. */
  async enqueueTaskWake(params: {
    taskId: string;
    agentId: string;
    runAt: Date;
    createdBy?: string;
  }): Promise<{ jobId: string }> {
    const { taskId, agentId, runAt, createdBy = 'heartbeat' } = params;
    const { rows } = await this.pool.query(
      `INSERT INTO scheduled_jobs
         (agent_id, cron_expr, run_at, task_payload, status, next_run_at, created_by, timezone, task_id)
       VALUES ($1, NULL, $2, $3, 'pending', $2, $4, $5, $6)
       RETURNING id`,
      [
        agentId,
        runAt,
        JSON.stringify({ type: 'task-wake', task_id: taskId }),
        createdBy,
        this.timezone,
        taskId,
      ],
    );
    return { jobId: (rows[0] as { id: string }).id };
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
    taskTitle: row.task_title ?? null,
    runStartedAt: row.run_started_at,
    expectedDurationSeconds: row.expected_duration_seconds,
    lastRunOutcome: row.last_run_outcome,
    lastRunSummary: row.last_run_summary,
    lastRunContext: row.last_run_context,
    // pg returns JSONB columns as plain JS objects — cast to the typed interface.
    originator: row.originator as TaskOriginator | null,
  };
}
