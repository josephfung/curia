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
});
