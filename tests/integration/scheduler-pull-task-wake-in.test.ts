// scheduler-pull-task-wake-in.test.ts — SchedulerService.pullTaskWakeIn (#2475, R64).
//
// The inbox heartbeat pulls its drain task's far-future wake back to now, so an injected
// task-update cannot park triage. Only a pending task-wake later than the target moves.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import type { EventBus as EventBusType } from '../../src/bus/bus.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'SchedulerPullTaskWakeIn Test';
const AGENT_ID = 'pull-wake-test-agent';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBusType;

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('SchedulerService.pullTaskWakeIn', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  let svc: SchedulerService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    svc = new SchedulerService(pool, new EventBus(logger as never), logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  const runAtOf = async (taskId: string): Promise<{ run_at: Date; status: string }> =>
    (await pool.query<{ run_at: Date; status: string }>(`SELECT run_at, status FROM scheduled_jobs WHERE task_id = $1`, [taskId])).rows[0]!;

  it('moves a far-future pending wake to the target time', async () => {
    const task = await repo.createTask({ agentId: AGENT_ID, title: `${PREFIX} far`, source: 'coordinator', wakeAt: new Date('2099-01-01T00:00:00Z') });
    // A target an hour out keeps other tests' pollers from claiming it.
    const target = new Date(Date.now() + 3_600_000);
    expect(await svc.pullTaskWakeIn(task.id, target)).toBe(true);
    expect((await runAtOf(task.id)).run_at.getTime()).toBe(target.getTime());
  });

  it('leaves a wake already due sooner, and a non-pending wake, alone', async () => {
    const soon = new Date(Date.now() + 1_800_000);
    const task = await repo.createTask({ agentId: AGENT_ID, title: `${PREFIX} soon`, source: 'coordinator', wakeAt: soon });
    expect(await svc.pullTaskWakeIn(task.id, new Date(Date.now() + 3_600_000))).toBe(false);
    const suspended = await repo.createTask({ agentId: AGENT_ID, title: `${PREFIX} suspended`, source: 'coordinator', wakeAt: new Date('2099-01-01T00:00:00Z') });
    await pool.query(`UPDATE scheduled_jobs SET status = 'suspended' WHERE task_id = $1`, [suspended.id]);
    expect(await svc.pullTaskWakeIn(suspended.id, new Date(Date.now() + 3_600_000))).toBe(false);
    expect((await runAtOf(suspended.id)).status).toBe('suspended');
  });
});
