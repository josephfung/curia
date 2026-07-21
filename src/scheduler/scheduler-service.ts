import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createScheduleCreated } from '../bus/events.js';
import type { TaskOriginator } from '../contacts/types.js';
import { makeSystemOriginator } from '../contacts/principal.js';
import { validateTaskErrorBudget } from '../tasks/task-error-budget.js';

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
  taskErrorBudget: Record<string, unknown> | null;
  taskTags: string[] | null;
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
  /** Cap the number of rows returned (most recent first). Omitted → no cap.
   *  Callers that feed results to an LLM must set this — an unbounded listing over
   *  a large jobs table overflows the model context window. (#1487) */
  limit?: number;
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
  task_error_budget: Record<string, unknown> | null;
  task_tags: string[] | null;
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
    if (errorBudget !== undefined) {
      const budgetError = validateTaskErrorBudget(errorBudget);
      if (budgetError) {
        throw new Error(budgetError);
      }
    }
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

    let jobId: string;
    let agentTaskId: string | undefined;

    if (intentAnchor) {
      // Wrap scheduled_jobs INSERT + tasks link CTE in one transaction so a failure
      // on the second step cannot leave an orphaned job row with drift detection disabled.
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
        null as string | null, // placeholder — jobId substituted after INSERT
      ];

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows } = await client.query(insertSql, insertParams);
        jobId = (rows[0] as { id: string }).id;
        taskParams[6] = jobId;

        const taskResult = await client.query(taskSql, taskParams);
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

        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          this.logger.error(
            { err: rollbackErr, agentId },
            'createJob: ROLLBACK failed after transaction error — connection may be in bad state',
          );
        }
        throw err;
      } finally {
        try {
          client.release();
        } catch (releaseErr) {
          this.logger.error(
            { err: releaseErr, agentId },
            'createJob: pg client release failed — connection may leak from pool',
          );
        }
      }
    } else {
      const { rows } = await this.pool.query(insertSql, insertParams);
      jobId = (rows[0] as { id: string }).id;
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
             t.error_budget AS task_error_budget,
             t.tags AS task_tags,
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Optional row cap, applied in SQL so a large jobs table never loads fully into
    // memory. Only added when the caller asks for one, so existing callers (HTTP
    // /api/jobs, setup-status) keep their full-list behaviour unchanged. (#1487)
    let limitClause = '';
    if (filters?.limit !== undefined && Number.isFinite(filters.limit) && filters.limit > 0) {
      limitClause = `LIMIT $${paramIndex}`;
      // Math.max(1, …) so a fractional limit in (0, 1) becomes LIMIT 1, not LIMIT 0
      // (Math.floor(0.5) === 0 would silently return zero rows).
      params.push(Math.max(1, Math.floor(filters.limit)));
      paramIndex++;
    }

    // Suppress unused-variable warning — paramIndex stays incremented for future filters.
    void paramIndex;

    const sql = `
      SELECT sj.*,
             t.id AS agent_task_id,
             t.intent_anchor,
             t.progress,
             t.error_budget AS task_error_budget,
             t.tags AS task_tags,
             t.title AS task_title
        FROM scheduled_jobs sj
        LEFT JOIN tasks t ON sj.task_id = t.id
       ${whereClause}
       ORDER BY sj.created_at DESC
       ${limitClause}
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
   * Set a job and its linked task to 'paused' in a single round-trip, returning the
   * number of job rows actually transitioned (0 when the job is missing or terminal).
   * Shared by the drift-pause and operator-pause paths so the SQL stays in one place.
   *
   * The scheduled_jobs UPDATE is the OUTER statement so result.rowCount reflects the
   * job (a CTE-wrapped final UPDATE would report the tasks row count instead, which is
   * 0 for jobs without a linked task). The task UPDATE runs in the CTE against the same
   * snapshot, so both see the pre-update status.
   *
   * The terminal-state guard prevents re-arming a job the CEO already ended: without it,
   * pausing a 'cancelled'/'completed' job then resuming it (unsuspendJob accepts 'paused')
   * would resurrect it. Drift only ever pauses active jobs, so the guard is a no-op there.
   */
  private async setPaused(jobId: string): Promise<number> {
    const result = await this.pool.query(
      `WITH paused_task AS (
         UPDATE tasks t
            SET status     = 'paused',
                updated_at = now()
           FROM scheduled_jobs sj
          WHERE sj.id = $1
            AND t.id = sj.task_id
            AND sj.status NOT IN ('cancelled', 'completed')
       )
       UPDATE scheduled_jobs
          SET status = 'paused'
        WHERE id = $1
          AND status NOT IN ('cancelled', 'completed')`,
      [jobId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Pause a job and its linked task due to intent drift detection.
   * Sets status = 'paused' on both tables.
   * The CEO must review and resume or cancel the job manually.
   */
  async pauseJobForDrift(jobId: string): Promise<void> {
    const count = await this.setPaused(jobId);
    if (count === 0) {
      // Drift only targets active jobs, so a miss here means the job vanished or was
      // ended concurrently — log rather than throw to keep the detector's flow intact.
      this.logger.warn({ jobId }, 'Drift pause matched no active job (already ended?)');
      return;
    }
    this.logger.info({ jobId }, 'Job paused due to intent drift detection');
  }

  /**
   * Pause a job and its linked task at an operator's explicit request
   * (e.g. the CEO asking Curia to pause a schedule via the scheduler-update skill).
   * Neutral counterpart to pauseJobForDrift — same state transition, no drift semantics.
   * Released by unsuspendJob(), which accepts both 'suspended' and 'paused' states.
   * Throws when the job is missing or already terminal so callers don't report a
   * silent no-op as success.
   */
  async pauseJob(jobId: string): Promise<void> {
    const count = await this.setPaused(jobId);
    if (count === 0) {
      throw new Error(`Job ${jobId} not found or already cancelled/completed`);
    }
    this.logger.info({ jobId }, 'Job paused by operator request');
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
    const result = await this.pool.query(sql, params);

    // A 0-row update means the job_id doesn't exist. Throw rather than return silently
    // so callers (e.g. the scheduler-update skill) surface a real failure instead of
    // reporting a no-op edit as success. The web PATCH route already checks existence
    // via getJob() before calling this, so this only bites genuinely-missing jobs.
    if (result.rowCount === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

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

    let jobId: string;
    let upsertResultRow: {
      id: string;
      prior_status?: string | null;
      prior_failures?: number | null;
      prior_error?: string | null;
    };

    if (schedule.intent_anchor) {
      // Wrap scheduled_jobs UPSERT + tasks link CTE in one transaction so a failure
      // on the link step cannot leave an orphaned job row with drift detection disabled.
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
      const taskParams = [
        agentId,
        schedule.intent_anchor,   // title
        schedule.intent_anchor,   // intent_anchor
        'active',
        JSON.stringify({}),
        agentId,                  // source_agent_id
        null as string | null,    // placeholder — jobId substituted after upsert
      ];

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows } = await client.query(sql, params);
        const row = rows[0] as typeof upsertResultRow | undefined;
        if (!row) {
          throw new Error(
            `upsertDeclarativeJob: upsert returned no row for ${sourceAgentId}/${agentId} (${schedule.cron})`,
          );
        }
        upsertResultRow = row;
        jobId = upsertResultRow.id;
        taskParams[6] = jobId;

        if (upsertResultRow.prior_status === 'cancelled') {
          await client.query(
            `UPDATE tasks
                SET status = 'active', updated_at = now()
               FROM scheduled_jobs sj
              WHERE sj.id = $1
                AND tasks.id = sj.task_id
                AND tasks.status = 'cancelled'`,
            [jobId],
          );
        }

        const taskResult = await client.query(taskSql, taskParams);
        const taskRow = taskResult.rows[0] as { task_id: string; job_id: string | null } | undefined;
        if (taskRow && !taskRow.job_id) {
          this.logger.error(
            { agentId, jobId, intentAnchor: schedule.intent_anchor, taskId: taskRow.task_id },
            'upsertDeclarativeJob: tasks row created but scheduled_jobs.task_id link failed — orphaned task',
          );
          throw new Error(`upsertDeclarativeJob: scheduled_jobs row ${jobId} not found when linking task`);
        }

        await client.query('COMMIT');

        const anchorCreated = taskRow != null;
        this.logger.info(
          { agentId, jobId, intentAnchor: schedule.intent_anchor, anchorCreated },
          anchorCreated
            ? 'upsertDeclarativeJob: tasks row created for intent_anchor (drift detection enabled)'
            : 'upsertDeclarativeJob: tasks row already exists — skipped (restart idempotency)',
        );
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          this.logger.error(
            { err: rollbackErr, agentId, sourceAgentId },
            'upsertDeclarativeJob: ROLLBACK failed after transaction error — connection may be in bad state',
          );
        }
        this.logger.error(
          { err, agentId, sourceAgentId, intentAnchor: schedule.intent_anchor },
          'upsertDeclarativeJob: failed to upsert job or create tasks row — transaction rolled back',
        );
        throw err;
      } finally {
        try {
          client.release();
        } catch (releaseErr) {
          this.logger.error(
            { err: releaseErr, agentId, sourceAgentId },
            'upsertDeclarativeJob: pg client release failed — connection may leak from pool',
          );
        }
      }
    } else {
      const { rows } = await this.pool.query(sql, params);
      const row = rows[0] as typeof upsertResultRow | undefined;
      if (!row) {
        throw new Error(
          `upsertDeclarativeJob: upsert returned no row for ${sourceAgentId}/${agentId} (${schedule.cron})`,
        );
      }
      upsertResultRow = row;
      jobId = upsertResultRow.id;
    }

    const revivedFromCancelled = upsertResultRow.prior_status === 'cancelled';

    // Reviving overrides a terminal 'cancelled' state, so surface it loudly — the
    // symmetric cancellation path (cancelStaleDeclarativeJobs) logs per row, and a
    // resurrection must be at least as visible. Include the failure bookkeeping the
    // upsert just wiped so the prior context survives in the logs. warn (not info)
    // because this silently undoes a deliberate cancelJob() if one was issued.
    if (revivedFromCancelled) {
      this.logger.warn(
        {
          jobId,
          sourceAgentId,
          agentId,
          cron: schedule.cron,
          priorConsecutiveFailures: upsertResultRow.prior_failures ?? null,
          priorLastError: upsertResultRow.prior_error ?? null,
        },
        'Declarative job revived from cancelled — its YAML declaration still exists. ' +
          'If this job was deliberately stopped, remove its schedule entry from the agent YAML instead of cancelling it.',
      );

      // When intent_anchor is set, revival reactivation runs inside the transaction above.
      // For schedules without intent_anchor, reactivate the linked task here.
      if (!schedule.intent_anchor) {
        await this.pool.query(
          `UPDATE tasks
              SET status = 'active', updated_at = now()
             FROM scheduled_jobs sj
            WHERE sj.id = $1
              AND tasks.id = sj.task_id
              AND tasks.status = 'cancelled'`,
          [jobId],
        );
      }
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
   * A completion write matched no 'running' row: the job was paused or cancelled while the
   * run was in flight. Log and report not-suspended rather than resurrecting the job.
   */
  private skippedCompletion(jobId: string): { suspended: boolean } {
    this.logger.info({ jobId }, 'Job completion skipped — job no longer running (paused/cancelled concurrently)');
    return { suspended: false };
  }

  /**
   * Complete a job run.
   * - On success: if recurring (has cron_expr), advance next_run_at and reset failures;
   *   if one-shot, mark as completed.
   * - On failure: increment consecutive_failures. If it reaches SUSPEND_THRESHOLD, auto-suspend.
   *
   * All completion writes are fenced on status NOT IN ('paused','cancelled') so a run that
   * finishes after a concurrent pause/cancel does not overwrite that state (see
   * skippedCompletion). Wake jobs completed straight from 'pending' still pass the fence.
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
        // Fence the completion on the job NOT being in an operator-intervention state:
        // if a pause or cancel landed while the run was in flight, this write matches 0
        // rows and is skipped, so the completion can't stamp 'pending'/'completed' back
        // over the pause/cancel. We exclude only 'paused'/'cancelled' (not "= running")
        // because wake jobs in the plan frontier are completed straight from 'pending'.
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
           WHERE id = $3 AND status NOT IN ('paused', 'cancelled')
        `;
        const res = await this.pool.query(updateSql, [nextRunAt, 'pending', jobId, 'completed', autoSummary ?? null]);
        if (res.rowCount === 0) return this.skippedCompletion(jobId);
      } else {
        // One-shot job: mark as completed (same pause/cancel fence).
        const updateSql = `
          UPDATE scheduled_jobs
             SET last_run_at = now(),
                 status = $1,
                 consecutive_failures = 0,
                 last_error = NULL,
                 run_started_at = NULL,
                 last_run_outcome = $3,
                 last_run_summary = COALESCE(last_run_summary, $4)
           WHERE id = $2 AND status NOT IN ('paused', 'cancelled')
        `;
        const res = await this.pool.query(updateSql, ['completed', jobId, 'completed', autoSummary ?? null]);
        if (res.rowCount === 0) return this.skippedCompletion(jobId);
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
       WHERE id = $4 AND status NOT IN ('paused', 'cancelled')
    `;
    const res = await this.pool.query(updateSql, [newFailures, error ?? null, newStatus, jobId, 'failed']);
    if (res.rowCount === 0) return this.skippedCompletion(jobId);

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

  /** Enqueue a one-shot wake for an EXISTING task. Revives the task's most-recent terminal
   *  wake row back to `pending` (or inserts one if none exists) with task_id preset so the
   *  dispatcher routes it to `agentId` with full task context, and touches the task's
   *  updated_at. Does not create a new task. See #1410 for the reuse + backoff rationale.
   *
   *  Three callers, all of which now get the revive + updated_at touch: the BacklogHeartbeat
   *  (backlog-heartbeat.ts), resumable continuation (resumable-continuation.ts), and the
   *  plan frontier (plan-frontier.ts). The continuation/frontier callers pre-guard with
   *  taskHasPendingWake and catch 23505, so on their paths the touch is redundant-but-harmless.
   *
   *  `originator` (the task's lineage, #1125) is persisted on the wake row so the woken task
   *  fires with provenance — previously it fired with metadata: undefined and lost all
   *  authorization standing. `derived` is carried in task_payload.standing and replayed by
   *  fireJob into the agent.task `wakeContext`, which drives the bypass ladder: the score can
   *  only ever DOWNGRADE the lineage's standing for this open-ended backlog wake, never grant it. */
  async enqueueTaskWake(params: {
    taskId: string;
    agentId: string;
    runAt: Date;
    createdBy?: string;
    originator?: TaskOriginator | null;
    /** True when the woken task is an agent-spawned child / side-effect (posture-D ladder column). */
    derived?: boolean;
  }): Promise<{ jobId: string }> {
    const { taskId, agentId, runAt, createdBy = 'heartbeat', originator = null, derived = false } = params;
    const payload = JSON.stringify({ type: 'task-wake', task_id: taskId, standing: { derived } });
    const originatorJson = originator ? JSON.stringify(originator) : null;
    const args = [agentId, runAt, payload, createdBy, this.timezone, taskId, originatorJson];

    // Fix 3 (#1410): reuse the task's existing terminal wake row instead of inserting a fresh
    // row every cycle. Left unbounded this accreted thousands of completed rows for a single
    // looping task; reusing keeps one scheduled_jobs row per task so the table stays searchable.
    // Failure bookkeeping is preserved when reviving a 'failed'/'suspended' row (mirrors
    // upsertDeclarativeJob) so the SUSPEND_THRESHOLD circuit-breaker accumulates across reuse
    // cycles for a persistently-failing wake; a clean 'completed'/'cancelled' row starts fresh.
    // Fix 1 (#1410): the _touch CTE bumps the task's updated_at so an *attended* task leaves the
    // heartbeat's idle window for a full idleThresholdHours rather than being re-selected on the
    // next tick (a no-op wake previously never bumped updated_at, so the task looped forever).
    // Safety rests on two invariants: the partial unique index
    // scheduled_jobs_one_active_wake_per_task_uq (migration 067) means only terminal rows are
    // revived and a racing insert loses with 23505; and the FK scheduled_jobs.task_id ON DELETE
    // SET NULL (migration 049) means a deleted task nulls the link, so a revive/insert for a gone
    // task fails with 23503 rather than ever touching a phantom task row.
    const revive = await this.pool.query(
      `WITH revived AS (
         UPDATE scheduled_jobs
            SET status = 'pending', run_at = $2, next_run_at = $2, run_started_at = NULL,
                consecutive_failures = CASE WHEN status IN ('failed','suspended') THEN consecutive_failures ELSE 0 END,
                last_error = CASE WHEN status IN ('failed','suspended') THEN last_error ELSE NULL END,
                last_run_outcome = CASE WHEN status IN ('failed','suspended') THEN last_run_outcome ELSE NULL END,
                agent_id = $1, created_by = $4, timezone = $5,
                task_payload = $3::jsonb, originator = $7::jsonb
          WHERE id = (
            SELECT id FROM scheduled_jobs
             WHERE task_id = $6 AND task_payload->>'type' = 'task-wake'
               AND status IN ('completed', 'failed', 'suspended', 'cancelled')
             ORDER BY created_at DESC
             LIMIT 1
          )
          -- Re-check the status on the target row itself, not just its id. Under READ COMMITTED
          -- two concurrent revives can both pick the same terminal row; without this predicate the
          -- second UPDATE (whose qual is only id = X) still matches after the first commits and
          -- silently re-revives the now-pending row. With it, the loser's UPDATE matches 0 rows,
          -- falls through to the INSERT, and loses cleanly on the one-active-wake index (23505).
          AND status IN ('completed', 'failed', 'suspended', 'cancelled')
         RETURNING id
       ),
       _touch AS (
         UPDATE tasks SET updated_at = now() WHERE id = $6 AND EXISTS (SELECT 1 FROM revived)
       )
       SELECT id FROM revived`,
      args,
    );
    if (revive.rows.length > 0) {
      return { jobId: (revive.rows[0] as { id: string }).id };
    }

    // No terminal wake row to reuse (first wake for this task) — insert a new one, touching
    // the task's updated_at in the same statement so the backoff applies to first wakes too.
    const { rows } = await this.pool.query(
      `WITH j AS (
         INSERT INTO scheduled_jobs
           (agent_id, cron_expr, run_at, task_payload, status, next_run_at, created_by, timezone, task_id, originator)
         VALUES ($1, NULL, $2, $3::jsonb, 'pending', $2, $4, $5, $6, $7::jsonb)
         RETURNING id
       ),
       _touch AS (
         UPDATE tasks SET updated_at = now() WHERE id = $6
       )
       SELECT id FROM j`,
      args,
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
    taskErrorBudget: row.task_error_budget ?? null,
    taskTags: row.task_tags ?? null,
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
