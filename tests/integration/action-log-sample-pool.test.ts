// Spot-check pool rows against real Postgres (#2159 Phase 3): the LLM judge never sees them,
// the scorer ignores them until the principal gives a verdict.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

// Every row this suite writes carries this task_id prefix so cleanup never touches other data.
const TASK_PREFIX = 'test-sample-pool-';

describeIf('action-log sample pool (#2159 Phase 3)', () => {
  let pool: pg.Pool;
  let repo: ActionLogRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Refuse anything but the isolated test database before writing a single row.
    await requireCuriaTestDatabase(pool);
    repo = new ActionLogRepo(pool, createSilentLogger());
  });

  afterEach(async () => {
    await pool.query('DELETE FROM autonomy_action_log WHERE task_id LIKE $1', [`${TASK_PREFIX}%`]);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedPoolRow(suffix: string): Promise<number> {
    return repo.insertSampled({
      taskId: `${TASK_PREFIX}${suffix}`,
      conversationId: 'email:th1',
      toolName: 'calendar-create-event',
      actionRisk: 'high',
      summary: 'Created "Sync with Dana" on Tuesday',
      signals: { firstContact: true },
    });
  }

  it('hides a pool row from the LLM judge but offers it as a spot-check candidate', async () => {
    const id = await seedPoolRow('judge');

    const unscored = await repo.findUnscoredTerminal(100_000);
    expect(unscored.map((r) => r.id)).not.toContain(id);

    const candidates = await repo.findSampleCandidates(new Date(Date.now() - 60_000), 1000);
    const row = candidates.find((r) => r.id === id);
    expect(row).toBeDefined();
    // The id is a number, not pg's int8 string.
    expect(typeof row!.id).toBe('number');
    expect(row!.description).toBe('Created "Sync with Dana" on Tuesday');
  });

  it('stops offering a row once it has been shown', async () => {
    const id = await seedPoolRow('shown');
    await repo.markSampled([id], new Date());

    const candidates = await repo.findSampleCandidates(new Date(Date.now() - 60_000), 1000);
    expect(candidates.map((r) => r.id)).not.toContain(id);
  });

  it('leaves a row outside the pool untouched when asked to mark it sampled', async () => {
    const id = await repo.insert({
      taskId: `${TASK_PREFIX}mark-not-pool`,
      toolName: 'calendar-create-event',
      actionRisk: 'high',
      outcome: 'success',
    });
    expect(await repo.markSampled([id], new Date())).toBe(0);
    const { rows } = await pool.query('SELECT payload FROM autonomy_action_log WHERE id = $1', [id]);
    expect(rows[0].payload).toBeNull();
  });

  it('scores nothing until the principal gives a verdict, then counts competence only', async () => {
    const before = await repo.countScored();
    const id = await seedPoolRow('verdict');

    // Unjudged pool row: not evidence yet.
    expect(await repo.countScored()).toBe(before);
    expect((await repo.findAllScored(100_000)).map((r) => r.id)).not.toContain(id);

    expect(await repo.recordPrincipalVerdict(id, false, 'x')).toBe(true);

    expect(await repo.countScored()).toBe(before + 1);
    const scored = (await repo.findAllScored(100_000)).find((r) => r.id === id);
    expect(scored).toBeDefined();
    expect(scored!.competenceFlag).toBe(0);
    expect(scored!.commitmentFlag).toBeNull();
    expect(scored!.compatibility).toBeNull();
    expect(scored!.scoredBy).toBe('principal');
  });

  it('refuses a verdict on a row that is not in the pool', async () => {
    const id = await repo.insert({
      taskId: `${TASK_PREFIX}not-pool`,
      toolName: 'calendar-create-event',
      actionRisk: 'high',
      outcome: 'success',
    });
    expect(await repo.recordPrincipalVerdict(id, true, null)).toBe(false);
  });
});
