// task-update-running-wake.test.ts — self-reschedule while the wake is running (#1938).
//
// The one-active-wake index covers pending AND running. updateTask must not INSERT
// beside a running row, and must not mutate that row's run_at (completion would
// mark it completed and drop the new time). The requested time lands on
// deferred_wake_at and is armed when the run finishes.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { EventBus } from '../../src/bus/bus.js';
import type { EventBus as EventBusType } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'TaskUpdateRunningWake Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBusType;

interface WakeRow {
  id: string;
  status: string;
  run_at: Date;
  next_run_at: Date;
  deferred_wake_at: Date | null;
  consecutive_failures: number;
  task_payload: Record<string, unknown>;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

async function wakeRowsFor(pool: pg.Pool, taskId: string): Promise<WakeRow[]> {
  const { rows } = await pool.query<WakeRow>(
    `SELECT id, status, run_at, next_run_at, deferred_wake_at, consecutive_failures, task_payload
       FROM scheduled_jobs WHERE task_id = $1 ORDER BY created_at`,
    [taskId],
  );
  return rows;
}

function activeWakes(rows: WakeRow[]): WakeRow[] {
  return rows.filter((r) => r.status === 'pending' || r.status === 'running');
}

describeIf('TaskRepo.updateTask running-wake reschedule (#1938)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  let scheduler: SchedulerService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    scheduler = new SchedulerService(pool, new EventBus(logger as never), logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  async function taskWithRunningWake(title: string): Promise<{ taskId: string; jobId: string }> {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} ${title}`,
      source: 'coordinator',
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const [initial] = await wakeRowsFor(pool, task.id);
    expect(initial).toBeDefined();
    await pool.query(
      `UPDATE scheduled_jobs SET status = 'running', run_started_at = now() WHERE id = $1`,
      [initial!.id],
    );
    return { taskId: task.id, jobId: initial!.id };
  }

  it('defers a reschedule while the wake is running, then arms it on completion', async () => {
    const { taskId, jobId } = await taskWithRunningWake('defer-then-arm');
    const wakeAt = new Date(Date.now() + 7_200_000);

    const updated = await repo.updateTask(taskId, { wakeAt }, 'coordinator');
    expect(updated).not.toBeNull();

    const mid = await wakeRowsFor(pool, taskId);
    expect(mid).toHaveLength(1);
    expect(mid[0]!.id).toBe(jobId);
    expect(mid[0]!.status).toBe('running');
    expect(activeWakes(mid)).toHaveLength(1);
    expect(new Date(mid[0]!.deferred_wake_at!).getTime()).toBe(wakeAt.getTime());
    // The in-flight run keeps its original fire time.
    expect(new Date(mid[0]!.run_at).getTime()).not.toBe(wakeAt.getTime());

    const result = await scheduler.completeJobRun(jobId, true);
    expect(result.suspended).toBe(false);

    const after = await wakeRowsFor(pool, taskId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(jobId);
    expect(after[0]!.status).toBe('pending');
    expect(new Date(after[0]!.run_at).getTime()).toBe(wakeAt.getTime());
    expect(new Date(after[0]!.next_run_at).getTime()).toBe(wakeAt.getTime());
    expect(after[0]!.deferred_wake_at).toBeNull();
    expect(after[0]!.task_payload).toEqual({ type: 'task-wake' });
    expect(activeWakes(after)).toHaveLength(1);
  });

  it('overwrites deferred_wake_at when the running wake is rescheduled twice', async () => {
    const { taskId } = await taskWithRunningWake('defer-overwrite');
    const first = new Date(Date.now() + 7_200_000);
    const second = new Date(Date.now() + 10_800_000);

    await repo.updateTask(taskId, { wakeAt: first }, 'coordinator');
    await repo.updateTask(taskId, { wakeAt: second }, 'coordinator');

    const rows = await wakeRowsFor(pool, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('running');
    expect(activeWakes(rows)).toHaveLength(1);
    expect(new Date(rows[0]!.deferred_wake_at!).getTime()).toBe(second.getTime());
  });

  it('arms the deferred time when the running wake fails', async () => {
    const { taskId, jobId } = await taskWithRunningWake('defer-on-failure');
    await pool.query(
      `UPDATE scheduled_jobs SET consecutive_failures = 2 WHERE id = $1`,
      [jobId],
    );
    const wakeAt = new Date(Date.now() + 7_200_000);
    await repo.updateTask(taskId, { wakeAt }, 'coordinator');

    const result = await scheduler.completeJobRun(jobId, false, 'boom');
    expect(result.suspended).toBe(false);

    const rows = await wakeRowsFor(pool, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(new Date(rows[0]!.run_at).getTime()).toBe(wakeAt.getTime());
    expect(new Date(rows[0]!.next_run_at).getTime()).toBe(wakeAt.getTime());
    expect(rows[0]!.deferred_wake_at).toBeNull();
    expect(rows[0]!.consecutive_failures).toBe(0);
    expect(activeWakes(rows)).toHaveLength(1);
  });

  it('drops a deferred wake when done and wakeAt are supplied together', async () => {
    const { taskId, jobId } = await taskWithRunningWake('terminal-wins');
    await repo.updateTask(taskId, { wakeAt: new Date(Date.now() + 7_200_000) }, 'coordinator');

    const later = new Date(Date.now() + 14_400_000);
    await repo.updateTask(taskId, { status: 'done', wakeAt: later }, 'coordinator');

    const mid = await wakeRowsFor(pool, taskId);
    expect(mid).toHaveLength(1);
    expect(mid[0]!.status).toBe('running');
    expect(mid[0]!.deferred_wake_at).toBeNull();

    await scheduler.completeJobRun(jobId, true);

    const after = await wakeRowsFor(pool, taskId);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('completed');
    expect(after[0]!.deferred_wake_at).toBeNull();
    expect(activeWakes(after)).toHaveLength(0);
  });

  it('arms the deferred time when a stuck running wake is recovered', async () => {
    const { taskId, jobId } = await taskWithRunningWake('recover-deferred');
    const wakeAt = new Date(Date.now() + 7_200_000);
    await repo.updateTask(taskId, { wakeAt }, 'coordinator');

    const result = await scheduler.recoverStuckJob(jobId, 600);
    expect(result.noOp).toBe(false);
    expect(result.suspended).toBe(false);

    const rows = await wakeRowsFor(pool, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(new Date(rows[0]!.run_at).getTime()).toBe(wakeAt.getTime());
    expect(new Date(rows[0]!.next_run_at).getTime()).toBe(wakeAt.getTime());
    expect(rows[0]!.deferred_wake_at).toBeNull();
    expect(activeWakes(rows)).toHaveLength(1);
  });

  it('applies a deferred wake when a paused running job is resumed', async () => {
    const { taskId, jobId } = await taskWithRunningWake('resume-deferred');
    const wakeAt = new Date(Date.now() + 7_200_000);
    await repo.updateTask(taskId, { wakeAt }, 'coordinator');

    await scheduler.pauseJob(jobId);
    await scheduler.unsuspendJob(jobId);

    const rows = await wakeRowsFor(pool, taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(new Date(rows[0]!.run_at).getTime()).toBe(wakeAt.getTime());
    expect(new Date(rows[0]!.next_run_at).getTime()).toBe(wakeAt.getTime());
    expect(rows[0]!.deferred_wake_at).toBeNull();
    expect(activeWakes(rows)).toHaveLength(1);
  });

  it('concurrent reschedule and completion leave exactly one active wake at the requested time', async () => {
    for (let i = 0; i < 20; i++) {
      const { taskId, jobId } = await taskWithRunningWake(`race-${i}`);
      const wakeAt = new Date(Date.now() + 3_600_000 + i * 1_000);

      await Promise.all([
        repo.updateTask(taskId, { wakeAt }, 'coordinator'),
        scheduler.completeJobRun(jobId, true),
      ]);

      const rows = await wakeRowsFor(pool, taskId);
      const active = activeWakes(rows);
      expect(active, `iteration ${i} active wakes`).toHaveLength(1);
      expect(active[0]!.status).toBe('pending');
      expect(new Date(active[0]!.run_at).getTime()).toBe(wakeAt.getTime());
      expect(new Date(active[0]!.next_run_at).getTime()).toBe(wakeAt.getTime());
      expect(active[0]!.deferred_wake_at).toBeNull();
    }
  });
});
