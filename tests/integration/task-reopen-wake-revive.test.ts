// task-reopen-wake-revive.test.ts — TaskRepo.reopenTask must restore the task's
// cancelled wake (CodeRabbit finding: reopenTask flipped status back to open but
// left the wake completeTask cancelled dead, so undoing an auto-complete produced
// an open task with no scheduled reminder). Mirrors the wake-revival assertions in
// task-update-wake-reuse.test.ts (#1415), applied to the reopen path (#1424).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'TaskReopenWake Test';
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
    next_run_at: Date;
    task_payload: Record<string, unknown>;
  }>(
    `SELECT id, status, run_at, next_run_at, task_payload FROM scheduled_jobs WHERE task_id = $1 ORDER BY created_at`,
    [taskId],
  );
  return rows;
}

describeIf('TaskRepo.reopenTask wake revival', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('revives the wake that completeTask cancelled, preserving its original schedule', async () => {
    const wakeAt = new Date(Date.now() + 3_600_000);
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} revive`,
      source: 'coordinator',
      wakeAt,
    });
    const [initial] = await wakeRowsFor(pool, task.id);
    expect(initial).toBeDefined();
    expect(initial!.status).toBe('pending');

    // completeTask cancels the pending wake as part of marking the task done —
    // this is the state the sent-mail auto-complete flow leaves behind.
    await repo.completeTask(task.id, 'auto-completed from sent mail', 'coordinator');
    const afterComplete = await wakeRowsFor(pool, task.id);
    expect(afterComplete).toHaveLength(1);
    expect(afterComplete[0]!.status).toBe('cancelled');

    const reopened = await repo.reopenTask(task.id, 'undo', 'coordinator');
    expect(reopened).not.toBeNull();
    expect(reopened!.status).toBe('open');

    const rows = await wakeRowsFor(pool, task.id);
    expect(rows).toHaveLength(1);
    // Same row reused (not a fresh insert), flipped back to pending, and the
    // original run_at is preserved since reopenTask has no new wakeAt to apply.
    expect(rows[0]!.id).toBe(initial!.id);
    expect(rows[0]!.status).toBe('pending');
    expect(new Date(rows[0]!.run_at).getTime()).toBe(wakeAt.getTime());
    expect(new Date(rows[0]!.next_run_at).getTime()).toBe(wakeAt.getTime());
  });

  it('reopening a task with no wake at all does not create one', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} no-wake`,
      source: 'coordinator',
    });
    await repo.completeTask(task.id, undefined, 'coordinator');
    expect(await wakeRowsFor(pool, task.id)).toHaveLength(0);

    const reopened = await repo.reopenTask(task.id, undefined, 'coordinator');
    expect(reopened).not.toBeNull();
    expect(reopened!.status).toBe('open');
    expect(await wakeRowsFor(pool, task.id)).toHaveLength(0);
  });
});
