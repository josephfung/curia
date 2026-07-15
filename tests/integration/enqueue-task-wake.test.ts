import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const PREFIX = 'ETW Test';

// enqueueTaskWake only needs the task row to exist (FK) — status is irrelevant to it.
// Seed as 'paused' (outside the heartbeat's open/in_progress/waiting/blocked selection
// window) so these tasks never leak into a concurrently-running selectHeartbeatCandidates
// test file. Our own assertions are scoped by task_id, so they're unaffected either way.
async function seedTask(pool: pg.Pool, o: { status?: string; updatedAt: Date }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, source_agent_id, created_by, tags, updated_at)
     VALUES ('coordinator',$1,'seeded',$2,'{}'::jsonb,'{}'::jsonb,'curia',50,'agent','coordinator','test','{}',$3) RETURNING id`,
    [`${PREFIX} ${o.status ?? 'paused'}`, o.status ?? 'paused', o.updatedAt],
  );
  const [row] = rows as Array<{ id: string }>;
  if (!row) throw new Error('seedTask: INSERT INTO tasks returned no rows');
  return row.id;
}

async function rowsForTask(pool: pg.Pool, taskId: string) {
  const { rows } = await pool.query(
    `SELECT id, status, run_at, task_payload, created_by FROM scheduled_jobs WHERE task_id = $1 ORDER BY created_at`,
    [taskId],
  );
  return rows as Array<{ id: string; status: string; run_at: Date; task_payload: Record<string, unknown>; created_by: string }>;
}

async function taskUpdatedAt(pool: pg.Pool, taskId: string): Promise<Date> {
  const { rows } = await pool.query(`SELECT updated_at FROM tasks WHERE id = $1`, [taskId]);
  return (rows[0] as { updated_at: Date }).updated_at;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('SchedulerService.enqueueTaskWake (#1410 reuse + updated_at touch)', () => {
  let pool: pg.Pool;
  let svc: SchedulerService;
  const logger = createSilentLogger();
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    svc = new SchedulerService(pool, { publish: vi.fn(), subscribe: vi.fn() } as never, logger, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('inserts a single pending wake on first enqueue', async () => {
    const taskId = await seedTask(pool, { updatedAt: new Date(Date.now() - 10 * 3600_000) });
    await svc.enqueueTaskWake({ taskId, agentId: 'coordinator', runAt: new Date() });
    const rows = await rowsForTask(pool, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.task_payload.type).toBe('task-wake');
  });

  it('revives the existing terminal wake row instead of inserting a new one', async () => {
    const taskId = await seedTask(pool, { updatedAt: new Date(Date.now() - 10 * 3600_000) });
    const first = await svc.enqueueTaskWake({ taskId, agentId: 'coordinator', runAt: new Date(Date.now() - 3600_000) });
    // Simulate the wake firing and completing (completeJobRun marks a one-shot wake 'completed').
    await pool.query(`UPDATE scheduled_jobs SET status = 'completed' WHERE id = $1`, [first.jobId]);

    const newRunAt = new Date(Date.now() + 600_000);
    const second = await svc.enqueueTaskWake({ taskId, agentId: 'coordinator', runAt: newRunAt });

    const rows = await rowsForTask(pool, taskId);
    expect(rows).toHaveLength(1); // reused, not accumulated
    expect(second.jobId).toBe(first.jobId); // same row id
    expect(rows[0]!.status).toBe('pending');
    expect(new Date(rows[0]!.run_at).getTime()).toBe(newRunAt.getTime());
  });

  it('bumps the task updated_at when enqueuing (no-op backoff)', async () => {
    const stale = new Date(Date.now() - 10 * 3600_000);
    const taskId = await seedTask(pool, { updatedAt: stale });
    await svc.enqueueTaskWake({ taskId, agentId: 'coordinator', runAt: new Date() });
    const after = await taskUpdatedAt(pool, taskId);
    expect(after.getTime()).toBeGreaterThan(stale.getTime());
    // touched to ~now, well within the idle threshold window
    expect(Date.now() - after.getTime()).toBeLessThan(60_000);
  });

  it('keeps at most one wake row under a concurrent double-enqueue from a terminal state', async () => {
    const taskId = await seedTask(pool, { updatedAt: new Date(Date.now() - 10 * 3600_000) });
    const first = await svc.enqueueTaskWake({ taskId, agentId: 'coordinator', runAt: new Date(Date.now() - 3600_000) });
    await pool.query(`UPDATE scheduled_jobs SET status = 'completed' WHERE id = $1`, [first.jobId]);

    const results = await Promise.allSettled([
      svc.enqueueTaskWake({ taskId, agentId: 'coordinator', runAt: new Date() }),
      svc.enqueueTaskWake({ taskId, agentId: 'coordinator', runAt: new Date() }),
    ]);
    // Deterministic: the revive UPDATE's terminal-status guard means exactly one caller revives
    // the row; the loser matches 0 rows, inserts, and loses on the partial unique index (23505).
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string; constraint?: string };
    expect(reason.code).toBe('23505');
    expect(reason.constraint).toBe('scheduled_jobs_one_active_wake_per_task_uq');
    // Invariant: exactly one row for the task, and exactly one active wake.
    const rows = await rowsForTask(pool, taskId);
    expect(rows).toHaveLength(1);
    expect(rows.filter((x) => x.status === 'pending' || x.status === 'running')).toHaveLength(1);
  });
});
