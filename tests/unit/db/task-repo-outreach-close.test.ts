// tests/unit/db/task-repo-outreach-close.test.ts
//
// A task that ends (done, cancelled or failed) closes its task_outreach rows, and those of the
// children reconciled with it (#2312). Best-effort: a failed close never fails the update.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Pool } from 'pg';
import { TaskRepo } from '../../../src/db/task-repo.js';
import type { EventBus } from '../../../src/bus/bus.js';

const logger = pino({ level: 'silent' });
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '55555555-5555-4555-8555-555555555555';

function taskRow(status: string) {
  return {
    id: TASK_ID, agent_id: 'coordinator', intent_anchor: 'Book physio', status, progress: {}, error_budget: {},
    conversation_id: 'c', created_at: new Date(), updated_at: new Date(), title: 'Book physio', description: null,
    owner: 'curia', waiting_on_contact_id: null, waiting_on_text: null, parent_task_id: null, blocked_by_task_id: null,
    priority: 0, due_at: null, source: 'agent', source_agent_id: 'coordinator', created_by: 'coordinator', tags: [],
    originator: null,
  };
}

/** A pool whose task reads return `open`, writes return `newStatus`, and reconcile returns `children`. */
function makePool(newStatus: string, children: string[] = [], currentStatus = 'open') {
  const query = vi.fn(async (sql: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (sql.includes('previous_status')) {
      return { rows: children.map((id) => ({ id, previous_status: 'open' })) };
    }
    if (/SELECT[\s\S]*FROM tasks WHERE id = \$1/.test(sql) && !sql.includes('UPDATE')) return { rows: [taskRow(currentStatus)] };
    return { rows: [taskRow(newStatus)] };
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

const bus = { publish: vi.fn(async () => undefined) } as unknown as EventBus;

describe('TaskRepo closes task outreach when a task ends', () => {
  it('completeTask closes the task and its reconciled children', async () => {
    const { pool } = makePool('done', [CHILD_ID]);
    const outreach = { closeForTask: vi.fn(async () => 1), reopenForTask: vi.fn(async () => 0) };
    const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach);
    await repo.completeTask(TASK_ID, 'Booked');
    expect(outreach.closeForTask).toHaveBeenCalledWith(TASK_ID);
    expect(outreach.closeForTask).toHaveBeenCalledWith(CHILD_ID);
  });

  it("updateTask to 'cancelled' closes the task's rows", async () => {
    const { pool } = makePool('cancelled');
    const outreach = { closeForTask: vi.fn(async () => 2), reopenForTask: vi.fn(async () => 0) };
    const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach);
    await repo.updateTask(TASK_ID, { status: 'cancelled' });
    expect(outreach.closeForTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('failResumableTask closes the task and its reconciled children', async () => {
    const { pool } = makePool('failed', [CHILD_ID]);
    const outreach = { closeForTask: vi.fn(async () => 1), reopenForTask: vi.fn(async () => 0) };
    const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach);
    await repo.failResumableTask(TASK_ID, { progressNote: 'circuit open', circuitState: {} as never, tags: [] });
    expect(outreach.closeForTask).toHaveBeenCalledWith(TASK_ID);
    expect(outreach.closeForTask).toHaveBeenCalledWith(CHILD_ID);
  });

  it('reopenTask reopens the task\'s outreach so replies find it again', async () => {
    const { pool } = makePool('open', [], 'done');
    const outreach = { closeForTask: vi.fn(async () => 0), reopenForTask: vi.fn(async () => 1) };
    const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach);
    await repo.reopenTask(TASK_ID, 'Undo');
    expect(outreach.reopenForTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('a failed outreach reopen does not fail the task reopen', async () => {
    const { pool } = makePool('open', [], 'done');
    const outreach = { closeForTask: vi.fn(async () => 0), reopenForTask: vi.fn(async () => { throw new Error('db down'); }) };
    const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach);
    await expect(repo.reopenTask(TASK_ID, 'Undo')).resolves.toMatchObject({ id: TASK_ID, status: 'open' });
  });

  it('a non-terminal update closes nothing', async () => {
    const { pool } = makePool('waiting');
    const outreach = { closeForTask: vi.fn(async () => 0), reopenForTask: vi.fn(async () => 0) };
    const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach);
    await repo.updateTask(TASK_ID, { status: 'waiting' });
    expect(outreach.closeForTask).not.toHaveBeenCalled();
  });

  // #2592: a task-wake ask bound to a finished task must stop matching later principal replies.
  describe('task-wake reply bindings', () => {
    const outreach = () => ({ closeForTask: vi.fn(async () => 0), reopenForTask: vi.fn(async () => 0) });
    const bindings = () => ({
      releaseTaskWakeBindingsForTask: vi.fn(async () => 1),
      restoreTaskWakeBindingsForTask: vi.fn(async () => 1),
    });

    it('completeTask releases the bindings of the task and its reconciled children', async () => {
      const { pool } = makePool('done', [CHILD_ID]);
      const b = bindings();
      const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach(), b);
      await repo.completeTask(TASK_ID, 'Booked');
      expect(b.releaseTaskWakeBindingsForTask).toHaveBeenCalledWith(TASK_ID);
      expect(b.releaseTaskWakeBindingsForTask).toHaveBeenCalledWith(CHILD_ID);
    });

    it("updateTask to 'cancelled' releases the task's bindings", async () => {
      const { pool } = makePool('cancelled');
      const b = bindings();
      const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach(), b);
      await repo.updateTask(TASK_ID, { status: 'cancelled' });
      expect(b.releaseTaskWakeBindingsForTask).toHaveBeenCalledWith(TASK_ID);
    });

    it('releases bindings even when no outreach repo is wired', async () => {
      const { pool } = makePool('done');
      const b = bindings();
      const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, undefined, b);
      await repo.completeTask(TASK_ID);
      expect(b.releaseTaskWakeBindingsForTask).toHaveBeenCalledWith(TASK_ID);
    });

    it('a non-terminal update releases nothing', async () => {
      const { pool } = makePool('waiting');
      const b = bindings();
      const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach(), b);
      await repo.updateTask(TASK_ID, { status: 'waiting' });
      expect(b.releaseTaskWakeBindingsForTask).not.toHaveBeenCalled();
    });

    it('a failed release does not fail the completion', async () => {
      const { pool } = makePool('done');
      const b = bindings();
      b.releaseTaskWakeBindingsForTask.mockRejectedValue(new Error('db down'));
      const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach(), b);
      await expect(repo.completeTask(TASK_ID)).resolves.toMatchObject({ id: TASK_ID, status: 'done' });
    });

    it('reopenTask restores the bindings its end released', async () => {
      const { pool } = makePool('open', [], 'done');
      const b = bindings();
      const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach(), b);
      await repo.reopenTask(TASK_ID, 'Undo');
      expect(b.restoreTaskWakeBindingsForTask).toHaveBeenCalledWith(TASK_ID);
    });

    it('a failed restore does not fail the reopen', async () => {
      const { pool } = makePool('open', [], 'done');
      const b = bindings();
      b.restoreTaskWakeBindingsForTask.mockRejectedValue(new Error('db down'));
      const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach(), b);
      await expect(repo.reopenTask(TASK_ID, 'Undo')).resolves.toMatchObject({ id: TASK_ID, status: 'open' });
    });
  });

  it('a failed close does not fail the completion', async () => {
    const { pool } = makePool('done');
    const outreach = { closeForTask: vi.fn(async () => { throw new Error('db down'); }), reopenForTask: vi.fn(async () => 0) };
    const repo = new TaskRepo(pool, bus, logger, 'UTC', undefined, outreach);
    await expect(repo.completeTask(TASK_ID)).resolves.toMatchObject({ id: TASK_ID, status: 'done' });
  });
});
