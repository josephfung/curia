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
import type { BusEvent, TaskUpdatedEvent } from '../../src/bus/events.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'TaskReopenWake Test';
const logger = pino({ level: 'silent' });

// Capturing bus stub — collects every published event so the event-emission case
// can assert reopenTask emits task.updated. The wake-revival / rejection cases
// ignore it. Reset per-test in beforeEach so each case sees only its own events.
const published: BusEvent[] = [];
const capturingBus = {
  publish: async (_layer: string, event: BusEvent) => {
    published.push(event);
  },
  subscribe: () => {},
} as unknown as EventBus;

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
  // Set true only after requireCuriaTestDatabase confirms we're on curia_test. cleanup()'s
  // DELETEs are PREFIX-scoped, but vitest still fires afterAll after a FAILED beforeAll, so
  // without this flag a guard abort against a mispointed DATABASE_URL would still run the
  // teardown DELETEs against whatever database it found. With it, no DELETE runs unguarded.
  let onTestDb = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Throws HERE (before onTestDb is set, before any DELETE) if DATABASE_URL points anywhere
    // but the canonical isolated curia_test database.
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
    repo = new TaskRepo(pool, capturingBus, logger as never, 'UTC');
  });
  afterAll(async () => { if (onTestDb) await cleanup(pool); await pool.end(); });
  beforeEach(async () => { if (!onTestDb) return; await cleanup(pool); published.length = 0; });

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

  // Only a 'done' task can be reopened — every other status is rejected. createTask
  // always inserts 'open', so the cancelled / in_progress cases are forced via SQL.
  it('rejects reopening a task that is not done', async () => {
    for (const status of ['cancelled', 'open', 'in_progress'] as const) {
      const task = await repo.createTask({
        agentId: 'coordinator',
        title: `${PREFIX} reject ${status}`,
        source: 'coordinator',
      });
      if (status !== 'open') {
        await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [status, task.id]);
      }

      await expect(repo.reopenTask(task.id, 'undo', 'coordinator')).rejects.toThrow(
        /only 'done' can be reopened/,
      );

      // The guard throws before any UPDATE, so the status is left untouched.
      const after = await repo.getTask(task.id);
      expect(after!.status).toBe(status);
    }
  });

  it('persists the audit note under progress.notes', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} audit note`,
      source: 'coordinator',
    });
    await repo.completeTask(task.id, undefined, 'coordinator');

    const auditNote = 'undo: reopened for follow-up';
    const reopened = await repo.reopenTask(task.id, auditNote, 'coordinator');
    expect(reopened).not.toBeNull();

    // The RETURNING row carries the appended note as the newest progress.notes entry.
    const returnedNotes = (reopened!.progress.notes ?? []) as Array<{ note: string }>;
    expect(returnedNotes.at(-1)?.note).toBe(auditNote);

    // ...and it is durably persisted — re-read straight from Postgres, not the
    // RETURNING row, to prove the jsonb_set append committed.
    const persisted = await repo.getTask(task.id);
    const persistedNotes = (persisted!.progress.notes ?? []) as Array<{ note: string }>;
    expect(persistedNotes.at(-1)?.note).toBe(auditNote);
  });

  it('emits a task.updated event (previousStatus done → newStatus open)', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} event`,
      source: 'coordinator',
    });
    await repo.completeTask(task.id, undefined, 'coordinator');
    // Drop the create/complete events so only the reopen's emission remains.
    published.length = 0;

    await repo.reopenTask(task.id, 'undo', 'coordinator');

    const updates = published.filter((e) => e.type === 'task.updated') as TaskUpdatedEvent[];
    expect(updates).toHaveLength(1);
    const { payload } = updates[0]!;
    expect(payload.taskId).toBe(task.id);
    expect(payload.previousStatus).toBe('done');
    expect(payload.newStatus).toBe('open');
    expect(payload.agentId).toBe('coordinator');
  });
});
