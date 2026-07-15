// scheduler-lifecycle-mutations.test.ts — pause / resume / edit against REAL Postgres (#1409).
//
// The scheduler-update skill delegates to SchedulerService.pauseJob / unsuspendJob /
// updateJob. Their correctness hinges on real SQL semantics that mocked-pool unit tests
// cannot exercise: the flipped CTE's rowCount (must reflect the scheduled_jobs UPDATE,
// not the tasks UPDATE), the terminal-state guard on pause, and the linked-task
// transitions. We drive the real service against real rows so a logically-wrong predicate
// fails here even though a SQL-substring unit assertion would pass.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const AGENT_ID = 'lifecycle-mut-test-agent';
const logger = pino({ level: 'silent' });

async function cleanup(pool: pg.Pool): Promise<void> {
  // Delete jobs first (they FK to tasks), then the tasks.
  await pool.query(`DELETE FROM scheduled_jobs WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM tasks WHERE agent_id = $1`, [AGENT_ID]);
}

// Insert a task + a cron scheduled_job linked to it, in the given statuses.
async function insertJobWithTask(
  pool: pg.Pool,
  jobStatus: string,
  taskStatus: string,
): Promise<{ jobId: string; taskId: string }> {
  const task = await pool.query(
    `INSERT INTO tasks (agent_id, intent_anchor, error_budget, status, title)
     VALUES ($1, 'keep X in sync', '{}'::jsonb, $2, 'test task')
     RETURNING id`,
    [AGENT_ID, taskStatus],
  );
  const taskId = task.rows[0]!.id as string;

  const futureRun = new Date(Date.now() + 3_600_000).toISOString();
  const job = await pool.query(
    `INSERT INTO scheduled_jobs
       (agent_id, source_agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone, task_id)
     VALUES ($1, $1, '0 9 * * *', $2, $3, $4, 'system', 'UTC', $5)
     RETURNING id`,
    [AGENT_ID, JSON.stringify({ task: 'sync' }), jobStatus, futureRun, taskId],
  );
  return { jobId: job.rows[0]!.id as string, taskId };
}

async function statuses(pool: pg.Pool, jobId: string, taskId: string): Promise<{ job: string; task: string }> {
  const j = await pool.query(`SELECT status FROM scheduled_jobs WHERE id = $1`, [jobId]);
  const t = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
  return { job: j.rows[0]!.status as string, task: t.rows[0]!.status as string };
}

describeIf('Scheduler lifecycle mutations against real Postgres (#1409)', () => {
  let pool: pg.Pool;
  let svc: SchedulerService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    svc = new SchedulerService(pool, new EventBus(logger as never), logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('pauseJob pauses the job and its linked task; unsuspendJob resumes both', async () => {
    const { jobId, taskId } = await insertJobWithTask(pool, 'pending', 'active');

    await svc.pauseJob(jobId);
    expect(await statuses(pool, jobId, taskId)).toEqual({ job: 'paused', task: 'paused' });

    await svc.unsuspendJob(jobId);
    const after = await statuses(pool, jobId, taskId);
    expect(after.job).toBe('pending');
    expect(after.task).toBe('active');
  });

  it('pauseJob throws (not silent no-op) when the job does not exist', async () => {
    // Random UUID that matches no row — the flipped CTE must report rowCount 0.
    await expect(
      svc.pauseJob('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('not found or already cancelled/completed');
  });

  it('pauseJob refuses to re-arm a cancelled (terminal) job', async () => {
    const { jobId, taskId } = await insertJobWithTask(pool, 'cancelled', 'cancelled');

    await expect(svc.pauseJob(jobId)).rejects.toThrow('not found or already cancelled/completed');

    // The terminal job must stay cancelled — no resurrection via pause → resume.
    expect((await statuses(pool, jobId, taskId)).job).toBe('cancelled');
  });

  it('pauseJob on a job WITHOUT a linked task still reports success via rowCount', async () => {
    // Guards the CTE-orientation bug: rowCount must reflect the scheduled_jobs UPDATE,
    // not the (zero-row) tasks UPDATE, or this would throw a false "not found".
    const futureRun = new Date(Date.now() + 3_600_000).toISOString();
    const job = await pool.query(
      `INSERT INTO scheduled_jobs
         (agent_id, source_agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone)
       VALUES ($1, $1, '0 9 * * *', $2, 'pending', $3, 'system', 'UTC')
       RETURNING id`,
      [AGENT_ID, JSON.stringify({ task: 'sync' }), futureRun],
    );
    const jobId = job.rows[0]!.id as string;

    await expect(svc.pauseJob(jobId)).resolves.toBeUndefined();
    const j = await pool.query(`SELECT status FROM scheduled_jobs WHERE id = $1`, [jobId]);
    expect(j.rows[0]!.status).toBe('paused');
  });

  it('updateJob changes the cron and recomputes next_run_at', async () => {
    const { jobId } = await insertJobWithTask(pool, 'pending', 'active');
    const before = await pool.query(`SELECT cron_expr, next_run_at FROM scheduled_jobs WHERE id = $1`, [jobId]);

    await svc.updateJob(jobId, { cronExpr: '30 14 * * 3' });

    const after = await pool.query(`SELECT cron_expr, next_run_at FROM scheduled_jobs WHERE id = $1`, [jobId]);
    expect(after.rows[0]!.cron_expr).toBe('30 14 * * 3');
    expect(after.rows[0]!.next_run_at).not.toEqual(before.rows[0]!.next_run_at);
  });

  it('updateJob throws when the job does not exist', async () => {
    await expect(
      svc.updateJob('00000000-0000-0000-0000-000000000000', { cronExpr: '30 14 * * 3' }),
    ).rejects.toThrow('not found');
  });

  it('a completion that lands after a pause does not resurrect the job', async () => {
    // Race: the job is 'running', the operator pauses it, then the in-flight run finishes
    // and calls completeJobRun. The status = 'running' fence must keep it 'paused'.
    const { jobId, taskId } = await insertJobWithTask(pool, 'running', 'active');

    await svc.pauseJob(jobId);
    expect((await statuses(pool, jobId, taskId)).job).toBe('paused');

    // Late successful completion of the recurring run — must be a no-op, not a reset to 'pending'.
    const result = await svc.completeJobRun(jobId, true);
    expect(result.suspended).toBe(false);
    expect((await statuses(pool, jobId, taskId)).job).toBe('paused');
  });
});
