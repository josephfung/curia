// task-repo-initial-status.test.ts — TaskRepo.createTask can create a task parked as `waiting`
// on a contact, against real Postgres (#2360). The heartbeat never selects such a task.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import { selectHeartbeatCandidates } from '../../src/db/queries/tasks.js';
import type { EventBus } from '../../src/bus/bus.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'TaskRepoStatus Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`, [`${PREFIX}%`]);
  // Tasks before contacts: tasks.waiting_on_contact_id references contacts.id.
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM contacts WHERE display_name LIKE $1`, [`${PREFIX}%`]);
}

describeIf('TaskRepo.createTask initial status (#2360)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  let contactId: string;
  let verified = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    verified = true;
    await pool.query('SELECT waiting_on_contact_id FROM tasks LIMIT 0');
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
  });
  afterAll(async () => {
    try {
      if (verified) await cleanup(pool);
    } finally {
      await pool.end();
    }
  });
  beforeEach(async () => {
    await cleanup(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contacts (display_name) VALUES ($1) RETURNING id`,
      [`${PREFIX} contact`],
    );
    contactId = rows[0]!.id;
  });

  it('creates a task open by default', async () => {
    const task = await repo.createTask({ agentId: 'coordinator', title: `${PREFIX} default`, source: 'coordinator' });
    expect(task.status).toBe('open');
  });

  it('creates a task waiting on a contact, with or without a wake', async () => {
    const plain = await repo.createTask({
      agentId: 'coordinator', title: `${PREFIX} waiting`, source: 'coordinator',
      status: 'waiting', waitingOnContactId: contactId,
    });
    expect(plain.status).toBe('waiting');
    expect((await repo.getTask(plain.id))?.status).toBe('waiting');

    // The wake_at path inserts through a CTE with its own parameter numbering.
    const woken = await repo.createTask({
      agentId: 'coordinator', title: `${PREFIX} waiting-wake`, source: 'coordinator',
      status: 'waiting', waitingOnContactId: contactId, wakeAt: new Date(Date.now() + 3_600_000),
    });
    expect(woken.status).toBe('waiting');
    const { rows } = await pool.query<{ agent_id: string; status: string }>(
      `SELECT agent_id, status FROM scheduled_jobs WHERE task_id = $1`,
      [woken.id],
    );
    expect(rows).toEqual([{ agent_id: 'coordinator', status: 'pending' }]);
  });

  it('a task created waiting on a contact is never a heartbeat candidate', async () => {
    const waiting = await repo.createTask({
      agentId: 'coordinator', title: `${PREFIX} parked`, source: 'scheduler', sourceAgentId: 'coordinator',
      status: 'waiting', waitingOnContactId: contactId,
    });
    const open = await repo.createTask({
      agentId: 'coordinator', title: `${PREFIX} idle`, source: 'scheduler', sourceAgentId: 'coordinator',
    });
    // Age both past the idle and stale-wait thresholds.
    await pool.query(`UPDATE tasks SET updated_at = now() - interval '60 hours' WHERE id = ANY($1::uuid[])`, [[waiting.id, open.id]]);
    const got = (await selectHeartbeatCandidates(pool, {
      eligibleAgents: ['coordinator'], idleThresholdHours: 4, staleWaitThresholdHours: 48, maxWakes: 50,
    })).map((c) => c.id);
    expect(got).not.toContain(waiting.id);
    expect(got).toContain(open.id);
  });
});
