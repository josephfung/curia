// task-repo-originator.test.ts — TaskRepo lineage stamping + child capping against real Postgres (#1125).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { TaskOriginator } from '../../src/contacts/types.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'TaskRepoOrig Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;

const PRINCIPAL: TaskOriginator = {
  contactId: 'ceo', systemRole: 'principal', channel: 'email',
  initiatedAt: '2026-06-23T00:00:00.000Z', tier: 'principal',
};
const SYSTEM: TaskOriginator = {
  contactId: 'system', systemRole: 'system', channel: 'declarative',
  initiatedAt: '2026-06-23T00:00:00.000Z', tier: null,
};

async function cleanup(pool: pg.Pool): Promise<void> {
  // scheduled_jobs.task_id is ON DELETE SET NULL, so the wake-job rows minted by the wake_at
  // tests must be deleted FIRST (while the task link still exists) — otherwise they'd survive
  // the task delete as task_id=NULL orphans, polluting the shared test DB (#1153).
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [`${PREFIX}%`],
  );
  // Children reference parents via parent_task_id — delete all test rows in one statement.
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('TaskRepo originator lineage (#1125)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT originator FROM tasks LIMIT 0');
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('stamps the creating originator onto a root task', async () => {
    const task = await repo.createTask({ agentId: 'coordinator', title: `${PREFIX} root`, source: 'coordinator', originator: PRINCIPAL });
    expect(task.originator).toEqual(PRINCIPAL);
    const reread = await repo.getTask(task.id);
    expect(reread?.originator).toEqual(PRINCIPAL);
  });

  it('leaves originator null when none is supplied', async () => {
    const task = await repo.createTask({ agentId: 'coordinator', title: `${PREFIX} none`, source: 'coordinator' });
    expect(task.originator).toBeNull();
  });

  it('caps a child task DOWN to the parent lineage (never above)', async () => {
    // Parent is system; a child that claims principal must be capped to system.
    const parent = await repo.createTask({ agentId: 'coordinator', title: `${PREFIX} parent`, source: 'coordinator', originator: SYSTEM });
    const child = await repo.createTask({
      agentId: 'coordinator', title: `${PREFIX} child`, source: 'agent',
      parentTaskId: parent.id, originator: PRINCIPAL,
    });
    expect(child.originator?.systemRole).toBe('system');
  });

  it('a child of a null-lineage parent gets null (cannot exceed the parent)', async () => {
    const parent = await repo.createTask({ agentId: 'coordinator', title: `${PREFIX} nullparent`, source: 'coordinator' });
    const child = await repo.createTask({
      agentId: 'coordinator', title: `${PREFIX} nullchild`, source: 'agent',
      parentTaskId: parent.id, originator: PRINCIPAL,
    });
    expect(child.originator).toBeNull();
  });

  // #1153: a wake_at deferral is pre-chosen, so its wake job must carry the task's originator
  // (like a scheduler-create job) and write NO `standing` envelope — fireJob then threads the
  // originator with no wakeContext, keeping the principal autonomy-bypass without the heartbeat ladder.
  describe('wake_at deferral threads originator onto the wake job (#1153)', () => {
    /** Fetch every wake job linked to a task (newest first), for asserting originator + payload. */
    async function wakeJobsFor(taskId: string) {
      const { rows } = await pool.query<{
        originator: TaskOriginator | null;
        task_payload: Record<string, unknown>;
        status: string;
      }>(
        `SELECT originator, task_payload, status FROM scheduled_jobs WHERE task_id = $1 ORDER BY created_at DESC`,
        [taskId],
      );
      return rows;
    }

    it('createTask with wake_at persists the task originator (no standing envelope)', async () => {
      const task = await repo.createTask({
        agentId: 'coordinator', title: `${PREFIX} wake-create`, source: 'coordinator',
        originator: PRINCIPAL, wakeAt: new Date(Date.now() + 3_600_000),
      });
      const jobs = await wakeJobsFor(task.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.originator).toEqual(PRINCIPAL);
      // No standing envelope: payload is the bare task-wake marker. This is what keeps the wake
      // out of the bypass ladder at fire time (the time was already decided).
      expect(jobs[0]!.task_payload).toEqual({ type: 'task-wake' });
    });

    it('updateTask with wake_at persists the existing task originator onto the new wake job', async () => {
      const task = await repo.createTask({
        agentId: 'coordinator', title: `${PREFIX} wake-update`, source: 'coordinator', originator: PRINCIPAL,
      });
      const updated = await repo.updateTask(task.id, { wakeAt: new Date(Date.now() + 3_600_000) }, 'coordinator');
      expect(updated).not.toBeNull();
      const pending = (await wakeJobsFor(task.id)).filter((j) => j.status === 'pending');
      expect(pending).toHaveLength(1);
      expect(pending[0]!.originator).toEqual(PRINCIPAL);
      expect(pending[0]!.task_payload).toEqual({ type: 'task-wake' });
    });

    it('a null-lineage task mints a wake job with null originator (no regression)', async () => {
      const task = await repo.createTask({
        agentId: 'coordinator', title: `${PREFIX} wake-nolineage`, source: 'coordinator',
        wakeAt: new Date(Date.now() + 3_600_000),
      });
      const jobs = await wakeJobsFor(task.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.originator).toBeNull();
    });
  });
});
