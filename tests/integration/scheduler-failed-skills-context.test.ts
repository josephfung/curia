// scheduler-failed-skills-context.test.ts — completeJobRun must tolerate a
// non-object last_run_context written by scheduler-report (#1830 review).
// A SQL-substring unit assertion cannot catch the regression this guards:
// `||` / `-` on a jsonb scalar throws at execution and leaves the job stuck.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const AGENT_ID = 'failed-skills-context-test-agent';
const logger = pino({ level: 'silent' });

describeIf('Scheduler failedSkills last_run_context (#1830)', () => {
  let pool: pg.Pool;
  let bus: EventBus;
  let svc: SchedulerService;
  let onTestDb = false;

  async function cleanup(): Promise<void> {
    if (!onTestDb) return;
    await pool.query(`DELETE FROM scheduled_jobs WHERE agent_id = $1`, [AGENT_ID]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
    bus = new EventBus(logger as never);
    svc = new SchedulerService(pool, bus, logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(); await pool?.end(); });
  beforeEach(async () => { await cleanup(); });

  async function insertRunningJob(contextJson: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO scheduled_jobs
         (agent_id, source_agent_id, cron_expr, task_payload, status, next_run_at,
          created_by, timezone, run_started_at, last_run_context)
       VALUES ($1, $1, '0 9 * * *', $2, 'running', now() + interval '1 day',
               'system', 'UTC', now(), $3::jsonb)
       RETURNING id`,
      [AGENT_ID, JSON.stringify({ task: 'sweep' }), contextJson],
    );
    return (rows[0] as { id: string }).id;
  }

  it('completeJobRun succeeds when last_run_context is a jsonb scalar', async () => {
    const jobId = await insertRunningJob('"done"');

    const result = await svc.completeJobRun(
      jobId,
      true,
      undefined,
      'sweep ok',
      [{ name: 'bullpen.post', error: 'Thread not found' }],
    );

    expect(result).toEqual({ suspended: false });
    const { rows } = await pool.query(
      `SELECT status, last_run_outcome, consecutive_failures, last_run_context
         FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    const row = rows[0] as {
      status: string;
      last_run_outcome: string;
      consecutive_failures: number;
      last_run_context: { failedSkills: Array<{ name: string }> };
    };
    expect(row.status).toBe('pending');
    expect(row.last_run_outcome).toBe('completed');
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_run_context.failedSkills).toEqual([
      { name: 'bullpen.post', error: 'Thread not found' },
    ]);
  });

  it('completeJobRun clears failedSkills keys on a scalar context without throwing', async () => {
    const jobId = await insertRunningJob('"done"');

    await svc.completeJobRun(jobId, true, undefined, 'all good');

    const { rows } = await pool.query(
      `SELECT last_run_context FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    // Non-object context is left alone when clearing (no throw).
    expect((rows[0] as { last_run_context: unknown }).last_run_context).toBe('done');
  });
});
