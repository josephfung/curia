import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { BacklogHeartbeat } from '../../src/scheduler/backlog-heartbeat.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const PREFIX = 'HBE2E Test';

async function seedTask(pool: pg.Pool, o: { status: string; owner?: string; sourceAgentId?: string | null; updatedAt: Date }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, source_agent_id, created_by, tags, updated_at)
     VALUES ($1,$2,'seeded',$3,'{}'::jsonb,'{}'::jsonb,$4,50,'agent',$5,'test','{}',$6) RETURNING id`,
    [o.sourceAgentId ?? 'coordinator', `${PREFIX} ${o.status}`, o.status, o.owner ?? 'curia', o.sourceAgentId ?? null, o.updatedAt],
  );
  return (rows[0] as unknown as { id: string }).id;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('BacklogHeartbeat end-to-end', () => {
  let pool: pg.Pool;
  const logger = createSilentLogger();
  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('enqueues exactly one pending wake per eligible agent, routed correctly', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    const idA = await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(5) });
    await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(6) }); // second for same agent — should NOT also wake
    const idC = await seedTask(pool, { status: 'open', sourceAgentId: 'coordinator', updatedAt: hoursAgo(5) });

    const schedulerService = new SchedulerService(pool, { publish: vi.fn(), subscribe: vi.fn() } as never, logger, 'UTC');
    const hb = new BacklogHeartbeat({
      pool, logger, schedulerService,
      eligibleAgents: new Set(['coordinator', 'ceo-inbox']),
      intervalMinutes: 60, maxWakesPerTick: 5, idleThresholdHours: 4, staleWaitThresholdHours: 48,
    });

    const enqueued = await hb.tick();
    expect(enqueued).toBe(2); // one per agent

    const { rows } = await pool.query(
      `SELECT agent_id, task_id, status, cron_expr FROM scheduled_jobs
       WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1) ORDER BY agent_id`,
      [`${PREFIX}%`],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r as unknown as { agent_id: string }).agent_id)).toEqual(['ceo-inbox', 'coordinator']);
    for (const r of rows) {
      const row = r as unknown as { status: string; cron_expr: string | null; task_id: string };
      expect(row.status).toBe('pending');
      expect(row.cron_expr).toBeNull(); // one-shot
    }
    // The two waked tasks are idA (or its sibling) and idC; a wake exists for ceo-inbox + coordinator.
    const wakedTaskIds = rows.map((r) => (r as unknown as { task_id: string }).task_id);
    expect(wakedTaskIds).toContain(idC);
    expect(wakedTaskIds.some((t) => t === idA || t !== idC)).toBe(true);
  });

  it('does not re-enqueue on a second tick (pending wake dedup)', async () => {
    await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: new Date(Date.now() - 5 * 3600_000) });
    const schedulerService = new SchedulerService(pool, { publish: vi.fn(), subscribe: vi.fn() } as never, logger, 'UTC');
    const hb = new BacklogHeartbeat({
      pool, logger, schedulerService,
      eligibleAgents: new Set(['ceo-inbox']),
      intervalMinutes: 60, maxWakesPerTick: 5, idleThresholdHours: 4, staleWaitThresholdHours: 48,
    });
    expect(await hb.tick()).toBe(1);
    expect(await hb.tick()).toBe(0); // already has a pending wake
  });
});
