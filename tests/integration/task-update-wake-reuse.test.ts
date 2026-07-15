// task-update-wake-reuse.test.ts — TaskRepo.updateTask wake row reuse (#1415).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'TaskUpdateWake Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

async function wakeRowsFor(pool: pg.Pool, taskId: string) {
  const { rows } = await pool.query<{
    id: string;
    status: string;
    run_at: Date;
  }>(
    `SELECT id, status, run_at FROM scheduled_jobs WHERE task_id = $1 ORDER BY created_at`,
    [taskId],
  );
  return rows;
}

describeIf('TaskRepo.updateTask wake row reuse (#1415)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('updates an existing pending wake in place on reschedule', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} reschedule`,
      source: 'coordinator',
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const [initial] = await wakeRowsFor(pool, task.id);
    expect(initial).toBeDefined();

    const newWakeAt = new Date(Date.now() + 7_200_000);
    await repo.updateTask(task.id, { wakeAt: newWakeAt }, 'coordinator');

    const rows = await wakeRowsFor(pool, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(initial!.id);
    expect(rows[0]!.status).toBe('pending');
    expect(new Date(rows[0]!.run_at).getTime()).toBe(newWakeAt.getTime());
    expect(rows.some((r) => r.status === 'cancelled')).toBe(false);
  });

  it('inserts a wake row when updateTask is the first wake for the task', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} first-wake`,
      source: 'coordinator',
    });
    expect(await wakeRowsFor(pool, task.id)).toHaveLength(0);

    const wakeAt = new Date(Date.now() + 3_600_000);
    await repo.updateTask(task.id, { wakeAt }, 'coordinator');

    const rows = await wakeRowsFor(pool, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(new Date(rows[0]!.run_at).getTime()).toBe(wakeAt.getTime());
  });

  it('cancels the pending wake when the task transitions to done', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} done-cancel`,
      source: 'coordinator',
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    await repo.updateTask(task.id, { status: 'done' }, 'coordinator');

    const rows = await wakeRowsFor(pool, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('cancelled');
  });

  it('cancels the pending wake when the task transitions to cancelled', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} cancelled-cancel`,
      source: 'coordinator',
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    await repo.updateTask(task.id, { status: 'cancelled' }, 'coordinator');

    const rows = await wakeRowsFor(pool, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('cancelled');
  });

  it('keeps exactly one wake row after repeated reschedules', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} repeated`,
      source: 'coordinator',
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const [initial] = await wakeRowsFor(pool, task.id);

    for (let i = 1; i <= 5; i++) {
      await repo.updateTask(
        task.id,
        { wakeAt: new Date(Date.now() + i * 3_600_000) },
        'coordinator',
      );
    }

    const rows = await wakeRowsFor(pool, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(initial!.id);
    expect(rows[0]!.status).toBe('pending');
  });
});
