// Approval numbers against real Postgres (#2159 Phase 3): ActionLogRepo.insert gives each
// pending approval the lowest number no row used in the last 7 days, under an advisory lock,
// and resolvePending accepts that number. Skips without DATABASE_URL.
//
// Two properties matter most, because an approval re-runs a skill with principal authority:
//   - a number is not handed out again inside the 7-day window, even once its approval is
//     resolved, so a late "approve 2" can never reach a different approval;
//   - concurrent inserts never share a number (proved with real concurrent connections).
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
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
    // Refuse anything but the isolated test database before writing a single row.
    await requireCuriaTestDatabase(pool);
    repo = new ActionLogRepo(pool, createSilentLogger());
  });

  // No table-wide reset: integration files run in parallel and other suites raise pending
  // approvals too, so every assertion below is about this suite's own rows and holds whatever
  // numbers other rows already took.

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

  /** The row's approval number, asserted non-null: every pending insert here must get one. */
  async function numberOf(id: number): Promise<number> {
    const n = await repo.findApprovalNumber(id);
    expect(n).not.toBeNull();
    return n!;
  }

  /** Ids of every row (any suite's) holding `n` inside the 7-day uniqueness window. */
  async function holdersInWindow(n: number): Promise<number[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM autonomy_action_log
       WHERE approval_number = $1 AND created_at > now() - interval '7 days'`,
      [n],
    );
    return rows.map((r) => Number(r.id));
  }

  async function backdate(id: number): Promise<void> {
    await pool.query(`UPDATE autonomy_action_log SET created_at = now() - interval '8 days' WHERE id = $1`, [id]);
  }

  it('never reuses a number inside 7 days, even once resolved, and frees it after', async () => {
    const [a, b, c] = [await insertPending(), await insertPending(), await insertPending()];
    const [nA, nB, nC] = [await numberOf(a), await numberOf(b), await numberOf(c)];
    expect(new Set([nA, nB, nC]).size).toBe(3);

    // Resolving b does not free its number: a late "approve <nB>" must not reach a new approval.
    await pool.query(`UPDATE autonomy_action_log SET outcome = 'approved' WHERE id = $1`, [b]);
    const d = await insertPending();
    const nD = await numberOf(d);
    expect([nA, nB, nC]).not.toContain(nD);

    // Once a's row is older than 7 days, nA is free again. The allocator takes the lowest free
    // number, so e gets nA or lower (a parallel suite's deleted row can free a lower one).
    await backdate(a);
    const e = await insertPending();
    const nE = await numberOf(e);
    expect([nB, nC, nD]).not.toContain(nE);
    if (nE > nA) {
      // Only possible when a parallel suite's approval claimed nA between the backdate and e's
      // insert. Then nA must be held by that other row, never by a again or by two rows.
      const holders = await holdersInWindow(nA);
      expect(holders).toHaveLength(1);
      expect(holders[0]).not.toBe(a);
    } else {
      expect(nE).toBeLessThanOrEqual(nA);
    }
  });

  it('gives ten concurrent inserts ten distinct numbers, held by no other row in the window', async () => {
    const ids = await Promise.all(Array.from({ length: CONCURRENT_INSERTS }, () => insertPending()));
    const numbers = await Promise.all(ids.map((id) => numberOf(id)));

    expect(new Set(numbers).size).toBe(CONCURRENT_INSERTS);

    // The security invariant itself, over every row in the table (not just this suite's): each
    // of these numbers has exactly one holder in the 7-day window.
    const { rows } = await pool.query<{ approval_number: number; holders: string }>(
      `SELECT approval_number, COUNT(*) AS holders FROM autonomy_action_log
       WHERE approval_number = ANY($1::int[]) AND created_at > now() - interval '7 days'
       GROUP BY approval_number`,
      [numbers],
    );
    expect(rows).toHaveLength(CONCURRENT_INSERTS);
    for (const row of rows) expect(Number(row.holders)).toBe(1);
  });

  it('leaves a non-pending row without a number', async () => {
    const id = await repo.insert({
      taskId: `${TASK_PREFIX}success`,
      toolName: 'email-send',
      actionRisk: 'medium',
      outcome: 'success',
    });
    expect(await repo.findApprovalNumber(id)).toBeNull();
  });

  it('resolves a pending approval by its number, and never an older row that held it', async () => {
    const old = await insertPending();
    const current = await insertPending();
    const n = await numberOf(current);
    // Make `old` an earlier holder of the same number, aged out of the window. It stays pending
    // and unexpired, so a lookup without the 7-day filter would find two rows.
    await pool.query(
      `UPDATE autonomy_action_log SET approval_number = $1, created_at = now() - interval '8 days' WHERE id = $2`,
      [n, old],
    );

    const hit = await repo.resolvePending(String(n));
    expect(hit.found).toBe(true);
    if (hit.found) {
      expect(hit.row.id).toBe(current);
      expect(hit.row.approvalNumber).toBe(n);
    }

    // Once resolved, the number reports already_resolved; the aged-out pending row is never
    // consulted, not even to explain the error.
    await pool.query(`UPDATE autonomy_action_log SET outcome = 'denied' WHERE id = $1`, [current]);
    expect(await repo.resolvePending(String(n))).toMatchObject({ found: false, reason: 'already_resolved' });

    // A number nobody holds in the window is not_found.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT n FROM generate_series(1, 999) AS n
       WHERE n NOT IN (SELECT approval_number FROM autonomy_action_log
                       WHERE approval_number IS NOT NULL AND created_at > now() - interval '7 days')
       ORDER BY n DESC LIMIT 1`,
    );
    expect(await repo.resolvePending(String(rows[0]!.n))).toMatchObject({ found: false, reason: 'not_found' });
  });

  it('reports a pending row past its expiry as expired', async () => {
    const id = await insertPending();
    const n = await numberOf(id);
    await pool.query(`UPDATE autonomy_action_log SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await repo.resolvePending(String(n))).toMatchObject({ found: false, reason: 'expired' });
  });
});
