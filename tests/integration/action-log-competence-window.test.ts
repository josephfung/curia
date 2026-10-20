// Competence evidence window against real Postgres (#2191): shadow rows and rows older than
// the age bound stay out of the error-rate guard, the capability rows and the sample count.
//
// The error rate and the counts are computed over the whole table, so each test runs inside a
// transaction on one client that locks the table against other writers, empties it, and rolls
// back: nothing outside it is seen or touched.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('action-log competence window (#2191)', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let repo: ActionLogRepo;
  // Set only once the database guard passes, so a failed guard never runs the cleanup below.
  let onTestDb = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
  });

  beforeEach(async () => {
    if (!onTestDb) return;
    client = await pool.connect();
    await client.query('BEGIN');
    // READ COMMITTED takes a fresh snapshot per statement, so rows other test files commit
    // mid-test would show up in the reads. This lock blocks their writes for the length of the
    // short transaction, and taking it before the DELETE orders it ahead of any row locks.
    await client.query('LOCK TABLE autonomy_action_log IN SHARE ROW EXCLUSIVE MODE');
    // Inside the transaction only: rolled back in afterEach. Bindings cascade.
    await client.query('DELETE FROM autonomy_action_log');
    // A PoolClient has the query() surface the repo uses.
    repo = new ActionLogRepo(client as unknown as pg.Pool, createSilentLogger());
  });

  afterEach(async () => {
    if (!onTestDb || !client) return;
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seed(outcome: string, competence: 0 | 1, ageDays: number, scoredBy: string): Promise<void> {
    await client.query(
      `INSERT INTO autonomy_action_log
         (task_id, skill_name, action_risk, outcome, competence_flag, scored_by, payload, created_at)
       VALUES ($1, 'test-skill', 'none', $2, $3, $4, $5, now() - make_interval(days => $6))`,
      [
        `test-window-${outcome}-${ageDays}-${Math.random()}`,
        outcome,
        competence,
        scoredBy,
        // The shadow unique index keys on payload.source_message_id.
        outcome === 'shadow_evaluated' ? JSON.stringify({ shadow: true, source_message_id: `src-${Math.random()}` }) : null,
        ageDays,
      ],
    );
  }

  it('leaves shadow rows out of the error rate', async () => {
    await seed('approved', 1, 1, 'deterministic');
    await seed('approved', 1, 2, 'deterministic');
    await seed('shadow_evaluated', 0, 1, 'shadow-reconciler');
    await seed('shadow_evaluated', 0, 2, 'shadow-reconciler');

    expect(await repo.getRecentCompetenceErrorRate(30, 90)).toBe(0);
  });

  it('leaves rows older than the age bound out of the error rate', async () => {
    await seed('approved', 1, 10, 'deterministic');
    await seed('failure', 0, 150, 'llm-judge');

    expect(await repo.getRecentCompetenceErrorRate(30, 90)).toBe(0);
    // Widening the bound brings the old failure back.
    expect(await repo.getRecentCompetenceErrorRate(30, 200)).toBe(0.5);
  });

  // Rows scored before #2159 Phase 3 could carry competence on an expired approval; the score
  // ignores them, so the guard must too.
  it('leaves expired rows out of the error rate', async () => {
    await seed('approved', 1, 1, 'deterministic');
    await seed('expired', 0, 2, 'deterministic');

    expect(await repo.getRecentCompetenceErrorRate(30, 90)).toBe(0);
  });

  it('returns null when every competence row is a shadow or too old', async () => {
    await seed('shadow_evaluated', 1, 1, 'shadow-reconciler');
    await seed('denied', 0, 120, 'deterministic');

    expect(await repo.getRecentCompetenceErrorRate(30, 90)).toBeNull();
  });

  it('leaves shadow rows out of the sample count and the capability rows', async () => {
    await seed('approved', 1, 1, 'deterministic');
    await seed('shadow_evaluated', 0, 1, 'shadow-reconciler');

    expect(await repo.countScored()).toBe(1);
    const rows = await repo.findAllScored();
    expect(rows.map((r) => r.outcome)).toEqual(['approved']);
  });
});
