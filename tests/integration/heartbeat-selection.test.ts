import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { selectHeartbeatCandidates } from '../../src/db/queries/tasks.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'HBSel Test';

/** Insert a task row directly; returns its id. `updatedAt` lets us simulate age. */
async function seedTask(
  pool: pg.Pool,
  opts: {
    title?: string;
    status: string;
    owner?: string;
    sourceAgentId?: string | null;
    blockedBy?: string | null;
    updatedAt: Date;
  },
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO tasks
       (agent_id, title, intent_anchor, status, progress, error_budget, owner,
        blocked_by_task_id, priority, source, source_agent_id, created_by, tags, updated_at)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,'{}'::jsonb,$5,$6,50,'agent',$7,'test','{}',$8)
     RETURNING id`,
    [
      opts.sourceAgentId ?? 'coordinator',
      `${PREFIX} ${opts.title ?? opts.status}`,
      'seeded',
      opts.status,
      opts.owner ?? 'curia',
      opts.blockedBy ?? null,
      opts.sourceAgentId ?? null,
      opts.updatedAt,
    ],
  );
  return (rows[0] as { id: string }).id;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('selectHeartbeatCandidates', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM tasks LIMIT 0');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  const opts = { eligibleAgents: ['coordinator', 'ceo-inbox'], idleThresholdHours: 4, staleWaitThresholdHours: 48, maxWakes: 5 };

  it('selects an idle, unblocked, curia-owned task older than the idle threshold', async () => {
    const id = await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(5) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got.map((c) => c.id)).toContain(id);
  });

  it('ignores a task touched within the idle threshold', async () => {
    await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(1) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got).toHaveLength(0);
  });

  it('excludes a task blocked by an unfinished task', async () => {
    const blocker = await seedTask(pool, { title: 'blocker', status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(10) });
    await seedTask(pool, { title: 'blocked', status: 'blocked', sourceAgentId: 'ceo-inbox', blockedBy: blocker, updatedAt: hoursAgo(10) });
    const got = await selectHeartbeatCandidates(pool, opts);
    // only the blocker (open, idle) is eligible; the blocked child is excluded
    expect(got.map((c) => c.id)).toEqual([blocker]);
  });

  it('includes a blocked task once its blocker is done (stale-wait path)', async () => {
    const blocker = await seedTask(pool, { title: 'doneblocker', status: 'done', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(60) });
    const child = await seedTask(pool, { title: 'unblocked', status: 'blocked', sourceAgentId: 'ceo-inbox', blockedBy: blocker, updatedAt: hoursAgo(60) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got.map((c) => c.id)).toContain(child);
  });

  it('skips a task that already has a pending wake', async () => {
    const id = await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(10) });
    await pool.query(
      `INSERT INTO scheduled_jobs (agent_id, cron_expr, run_at, task_payload, status, next_run_at, created_by, task_id)
       VALUES ('ceo-inbox', NULL, now(), '{}'::jsonb, 'pending', now(), 'test', $1)`,
      [id],
    );
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got.map((c) => c.id)).not.toContain(id);
  });

  it('returns at most one entry per effective agent', async () => {
    await seedTask(pool, { title: 'a', status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(10) });
    await seedTask(pool, { title: 'b', status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(8) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got.filter((c) => c.agentId === 'ceo-inbox')).toHaveLength(1);
  });

  it('routes a non-eligible / null source_agent_id to the coordinator fallback', async () => {
    const id = await seedTask(pool, { status: 'open', sourceAgentId: null, updatedAt: hoursAgo(10) });
    const got = await selectHeartbeatCandidates(pool, opts);
    const row = got.find((c) => c.id === id);
    expect(row?.agentId).toBe('coordinator');
  });

  it('does not advance a non-curia idle task (owner=ceo, open)', async () => {
    await seedTask(pool, { status: 'open', owner: 'ceo', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(10) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got).toHaveLength(0);
  });
});
