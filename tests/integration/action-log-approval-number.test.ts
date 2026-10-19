// Approval numbers against real Postgres (#2159 Phase 3): ActionLogRepo.insert gives each
// pending approval the lowest number no row used in the last 7 days, under an advisory lock,
// and resolvePending accepts that number. Skips without DATABASE_URL.
//
// Two properties matter most, because an approval re-runs a skill with principal authority:
//   - a number is not handed out again inside the 7-day window, even once its approval is
//     resolved, so a late "approve 2" can never reach a different approval;
//   - concurrent inserts never share a number (proved with real concurrent connections).
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

// Every row this suite writes carries this task_id prefix so cleanup never touches other data.
const TASK_PREFIX = 'test-approval-number-';
const CONCURRENT_INSERTS = 10;

describeIf('action-log approval numbers (#2159 Phase 3)', () => {
  let pool: pg.Pool;
  let repo: ActionLogRepo;
  let seq = 0;

  beforeAll(async () => {
    // max above CONCURRENT_INSERTS: every concurrent insert holds its own connection at once,
    // so the allocations genuinely overlap rather than queueing for a pooled client.
    pool = new Pool({ connectionString: DATABASE_URL, max: CONCURRENT_INSERTS + 5 });
    // Refuse anything but the isolated test database: beforeEach clears numbers table-wide.
    await requireCuriaTestDatabase(pool);
    repo = new ActionLogRepo(pool, createSilentLogger());
  });

  beforeEach(async () => {
    // Allocation looks at every row of the last 7 days, not only this suite's. Clear the
    // numbers other suites (or an earlier run) left behind so the expected values are exact.
    // Only the number is cleared; no other suite reads it.
    await pool.query('UPDATE autonomy_action_log SET approval_number = NULL WHERE approval_number IS NOT NULL');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM autonomy_action_log WHERE task_id LIKE $1', [`${TASK_PREFIX}%`]);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertPending(): Promise<number> {
    seq += 1;
    return repo.insert({
      taskId: `${TASK_PREFIX}${seq}`,
      toolName: 'email-send',
      actionRisk: 'medium',
      outcome: 'pending_approval',
      // Random, like generateShortRef(): short_ref has a global unique constraint (migration 033).
      shortRef: randomBytes(4).toString('hex'),
      description: `Send email to dana@example.com (${seq})`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }

  async function numberOf(id: number): Promise<number | null> {
    return repo.findApprovalNumber(id);
  }

  it('hands out the lowest free number, never reuses one inside 7 days, and reuses it after', async () => {
    const [a, b, c] = [await insertPending(), await insertPending(), await insertPending()];
    expect([await numberOf(a), await numberOf(b), await numberOf(c)]).toEqual([1, 2, 3]);

    // Resolving number 2 does not free it: a late "approve 2" must not reach a new approval.
    await pool.query(`UPDATE autonomy_action_log SET outcome = 'approved' WHERE id = $1`, [b]);
    const d = await insertPending();
    expect(await numberOf(d)).toBe(4);

    // Once number 1's row is older than 7 days, the number is free again.
    await pool.query(`UPDATE autonomy_action_log SET created_at = now() - interval '8 days' WHERE id = $1`, [a]);
    const e = await insertPending();
    expect(await numberOf(e)).toBe(1);
  });

  it('gives ten concurrent inserts ten distinct numbers', async () => {
    const ids = await Promise.all(Array.from({ length: CONCURRENT_INSERTS }, () => insertPending()));
    const numbers = await Promise.all(ids.map((id) => numberOf(id)));

    expect(numbers.every((n) => n !== null)).toBe(true);
    expect(new Set(numbers).size).toBe(CONCURRENT_INSERTS);
    // Serialised by the lock, they fill 1..10 with no gaps.
    expect([...numbers].sort((x, y) => x! - y!)).toEqual(Array.from({ length: CONCURRENT_INSERTS }, (_, i) => i + 1));
  });

  it('leaves a non-pending row without a number', async () => {
    const id = await repo.insert({
      taskId: `${TASK_PREFIX}success`,
      toolName: 'email-send',
      actionRisk: 'medium',
      outcome: 'success',
    });
    expect(await numberOf(id)).toBeNull();
  });

  it('resolves a pending approval by its number, and never an older row that held it', async () => {
    const old = await insertPending();
    // Age the first holder of number 1 past the window, so number 1 is reused.
    await pool.query(`UPDATE autonomy_action_log SET created_at = now() - interval '8 days' WHERE id = $1`, [old]);
    const current = await insertPending();
    expect(await numberOf(current)).toBe(1);

    const hit = await repo.resolvePending('1');
    expect(hit.found).toBe(true);
    if (hit.found) {
      expect(hit.row.id).toBe(current);
      expect(hit.row.approvalNumber).toBe(1);
    }

    // Once resolved, the number reports already_resolved; the aged-out row is never consulted.
    await pool.query(`UPDATE autonomy_action_log SET outcome = 'denied' WHERE id = $1`, [current]);
    const resolved = await repo.resolvePending('1');
    expect(resolved).toMatchObject({ found: false, reason: 'already_resolved' });

    // A number nobody holds in the window is not_found.
    expect(await repo.resolvePending('999')).toMatchObject({ found: false, reason: 'not_found' });
  });

  it('reports a pending row past its expiry as expired', async () => {
    const id = await insertPending();
    await pool.query(`UPDATE autonomy_action_log SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await repo.resolvePending('1')).toMatchObject({ found: false, reason: 'expired' });
  });
});
