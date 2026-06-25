// scheduler-claim-idempotency.test.ts — the cron claim is idempotent against overlapping
// poll cycles, against real Postgres (#1159).
//
// Reproduces the duplicate-daily-digest double-fire: the agent runs synchronously inside
// fireJob, so one pollDueJobs() drain takes minutes while the 30s interval keeps launching
// fresh polls. A job still 'pending' when poll B's SELECT runs is captured into poll B's
// in-memory list; poll A then claims and fires it, completeJobRun resets the recurring job
// to 'pending', and poll B — still holding the stale row — reaches it and fires a duplicate.
// The fix re-checks next_run_at <= now() in the claim UPDATE, so the stale re-claim sees a
// future next_run_at (advanced by the first claim) and matches 0 rows.
//
// We drive the REAL Scheduler.fireJob against a REAL row so the production claim SQL is the
// thing under test — a SQL-substring unit assertion would pass even if the predicate were
// logically wrong. fireJob is private; the cast is deliberate and scoped to this test.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { SchedulerService, type JobRow } from '../../src/scheduler/scheduler-service.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const AGENT_ID = 'claim-idem-test-agent';
const logger = pino({ level: 'silent' });

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE agent_id = $1`, [AGENT_ID]);
}

describeIf('Scheduler cron claim idempotency (#1159)', () => {
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

  it('fires a due cron job once even when a stale concurrent poll re-claims it after completion', async () => {
    // Insert a recurring cron job that is due now (next_run_at in the past).
    const pastDue = new Date(Date.now() - 60_000).toISOString();
    const insert = await pool.query(
      `INSERT INTO scheduled_jobs
         (agent_id, source_agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone)
       VALUES ($1, $1, $2, $3, 'pending', $4, 'system', 'UTC')
       RETURNING id`,
      [AGENT_ID, '0 9 * * *', JSON.stringify({ task: 'send digest' }), pastDue],
    );
    const jobId = insert.rows[0]!.id as string;

    // The stale in-memory row both overlapping polls hold: next_run_at still in the past.
    const staleRow: JobRow = {
      id: jobId, agentId: AGENT_ID, cronExpr: '0 9 * * *', runAt: null,
      taskPayload: { task: 'send digest' }, status: 'pending',
      lastRunAt: null, nextRunAt: pastDue, lastError: null, consecutiveFailures: 0,
      createdBy: 'system', createdAt: new Date().toISOString(), timezone: 'UTC',
      agentTaskId: null, intentAnchor: null, progress: null, taskTitle: null,
      runStartedAt: null, expectedDurationSeconds: null, lastRunOutcome: null,
      lastRunSummary: null, lastRunContext: null, originator: null,
    };

    // Count agent.task fires. (Use a real bus subscription on the system layer — fireJob
    // publishes the task there.)
    let fireCount = 0;
    bus.subscribe('agent.task', 'system', () => { fireCount += 1; });

    // fireJob is private; the cast is intentional so the production claim SQL is exercised.
    const fireJob = (job: JobRow) =>
      (scheduler as unknown as { fireJob(j: JobRow): Promise<void> }).fireJob(job);

    // Poll A fires the job → claims it, advances next_run_at to the next occurrence.
    await fireJob(staleRow);
    // The recurring job completes and reverts to 'pending' (the window that reopened the claim).
    await schedulerService.completeJobRun(jobId, true);
    // Poll B reaches the same stale row and attempts to fire it again.
    await fireJob(staleRow);

    // Without the next_run_at guard this is 2 (duplicate digest). With it, the second claim
    // matches 0 rows because the first claim already advanced next_run_at into the future.
    expect(fireCount).toBe(1);

    // The row is back to 'pending' (from completeJobRun) with next_run_at in the future,
    // not stuck 'running' from a phantom second claim.
    const after = await pool.query(
      `SELECT status, next_run_at > now() AS in_future FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    expect(after.rows[0]!.status).toBe('pending');
    expect(after.rows[0]!.in_future).toBe(true);
  });
});
