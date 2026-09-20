// scheduler-last-run-summary-reset.test.ts — claim clears last_run_summary so
// completeJobRun's COALESCE reflects *this* run, not a stale prior write (#1829).
// last_run_context is deliberately left alone so continuity cursors survive a
// crash/timeout before the next scheduler-report.
//
// Against real Postgres: a SQL-substring unit assertion cannot prove the end-to-end
// writer interaction (claim NULL summary → optional reportJobRun → completeJobRun
// COALESCE / recoverStuckJob leave-alone).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { SchedulerService, type JobRow } from '../../src/scheduler/scheduler-service.js';
import { deriveJobObjective } from '../../src/scheduler/job-notification-context.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const AGENT_ID = 'last-run-summary-reset-test-agent';
const logger = pino({ level: 'silent' });

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE agent_id = $1`, [AGENT_ID]);
}

describeIf('Scheduler last_run_summary reset at claim (#1829)', () => {
  let pool: pg.Pool;
  let bus: EventBus;
  let schedulerService: SchedulerService;
  let scheduler: Scheduler;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    bus = new EventBus(logger as never);
    schedulerService = new SchedulerService(pool, bus, logger as never, 'UTC');
    scheduler = new Scheduler({ pool, bus, logger: logger as never, schedulerService });
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  async function insertDueCronJob(summary: string | null, context: Record<string, unknown> | null = null): Promise<string> {
    const pastDue = new Date(Date.now() - 60_000).toISOString();
    const insert = await pool.query(
      `INSERT INTO scheduled_jobs
         (agent_id, source_agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone,
          last_run_summary, last_run_context)
       VALUES ($1, $1, $2, $3, 'pending', $4, 'system', 'UTC', $5, $6)
       RETURNING id`,
      [
        AGENT_ID,
        '0 9 * * *',
        JSON.stringify({ task: 'sweep calendar holds' }),
        pastDue,
        summary,
        context === null ? null : JSON.stringify(context),
      ],
    );
    return insert.rows[0]!.id as string;
  }

  function jobRowFor(jobId: string, nextRunAt: string): JobRow {
    return {
      id: jobId, agentId: AGENT_ID, cronExpr: '0 9 * * *', runAt: null,
      taskPayload: { task: 'sweep calendar holds' }, status: 'pending',
      lastRunAt: null, nextRunAt, lastError: null, consecutiveFailures: 0,
      createdBy: 'system', createdAt: new Date().toISOString(), timezone: 'UTC',
      agentTaskId: null, intentAnchor: null, progress: null,
      taskErrorBudget: null, taskTags: null, taskTitle: null,
      runStartedAt: null, expectedDurationSeconds: null, lastRunOutcome: null,
      lastRunSummary: 'stale from prior run — should not survive claim', lastRunContext: { scanned: 99 },
      originator: null,
    };
  }

  const fireJob = (job: JobRow) =>
    (scheduler as unknown as { fireJob(j: JobRow): Promise<void> }).fireJob(job);

  it('replaces a prior summary with the new auto-summary when scheduler-report is not called', async () => {
    const jobId = await insertDueCronJob('Calendar holds sweep completed: 0 scanned…', { offset: 500 });
    const pastDue = new Date(Date.now() - 60_000).toISOString();

    await fireJob(jobRowFor(jobId, pastDue));

    // Mid-run: summary cleared; context survives so a crash before report keeps the cursor.
    const mid = await schedulerService.getJob(jobId);
    expect(mid!.status).toBe('running');
    expect(mid!.lastRunSummary).toBeNull();
    expect(mid!.lastRunContext).toEqual({ offset: 500 });
    expect(deriveJobObjective(mid!)).toBe('sweep calendar holds');

    await schedulerService.completeJobRun(jobId, true, undefined, 'auto: 2 scanned, 1 expired');

    const after = await schedulerService.getJob(jobId);
    expect(after!.lastRunSummary).toBe('auto: 2 scanned, 1 expired');
    expect(after!.lastRunContext).toEqual({ offset: 500 });
    expect(after!.status).toBe('pending');
  });

  it('keeps an explicit scheduler-report summary over the auto-summary', async () => {
    const jobId = await insertDueCronJob('prior run summary', { scanned: 1 });
    const pastDue = new Date(Date.now() - 60_000).toISOString();

    await fireJob(jobRowFor(jobId, pastDue));
    await schedulerService.reportJobRun(jobId, 'agent: 5 scanned, 2 expired', { scanned: 5, expired: 2 });
    await schedulerService.completeJobRun(jobId, true, undefined, 'auto: should not win');

    const after = await schedulerService.getJob(jobId);
    expect(after!.lastRunSummary).toBe('agent: 5 scanned, 2 expired');
    expect(after!.lastRunContext).toEqual({ scanned: 5, expired: 2 });
  });

  it('preserves last_run_context when scheduler-report omits context', async () => {
    const jobId = await insertDueCronJob('prior', { offset: 500 });
    const pastDue = new Date(Date.now() - 60_000).toISOString();

    await fireJob(jobRowFor(jobId, pastDue));
    // Summary-only report — must not wipe the continuity cursor.
    await schedulerService.reportJobRun(jobId, 'swept another batch');
    await schedulerService.completeJobRun(jobId, true, undefined, 'auto: should not win');

    const after = await schedulerService.getJob(jobId);
    expect(after!.lastRunSummary).toBe('swept another batch');
    expect(after!.lastRunContext).toEqual({ offset: 500 });
  });

  it('leaves last_run_summary NULL after a timeout but keeps last_run_context', async () => {
    const jobId = await insertDueCronJob('looked successful last time', { offset: 500 });
    const pastDue = new Date(Date.now() - 60_000).toISOString();

    await fireJob(jobRowFor(jobId, pastDue));

    const mid = await schedulerService.getJob(jobId);
    expect(mid!.lastRunSummary).toBeNull();
    expect(mid!.lastRunContext).toEqual({ offset: 500 });

    const recovered = await schedulerService.recoverStuckJob(jobId, 900);
    expect(recovered.noOp).toBe(false);

    const after = await schedulerService.getJob(jobId);
    expect(after!.lastRunSummary).toBeNull();
    expect(after!.lastRunContext).toEqual({ offset: 500 });
    expect(after!.lastError).toMatch(/timed out/i);
    expect(after!.lastRunOutcome).toBe('timed_out');
  });

  it('does not stamp completion over a pause that landed mid-run', async () => {
    const jobId = await insertDueCronJob('prior', null);
    const pastDue = new Date(Date.now() - 60_000).toISOString();

    await fireJob(jobRowFor(jobId, pastDue));
    await pool.query(`UPDATE scheduled_jobs SET status = 'paused' WHERE id = $1`, [jobId]);

    const result = await schedulerService.completeJobRun(jobId, true, undefined, 'auto after pause');
    // skippedCompletion returns without writing; status stays paused and summary stays NULL.
    expect(result).toEqual({ suspended: false });

    const after = await schedulerService.getJob(jobId);
    expect(after!.status).toBe('paused');
    expect(after!.lastRunSummary).toBeNull();
  });
});
