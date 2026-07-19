// Integration test — runs migration 074's Up SQL against a live Postgres and asserts the
// shadow-eval dedup + partial-unique-index idempotency guard. Skips without DATABASE_URL.
// Scopes every mutation to a test-only source_message_id prefix and drops its own index, so a
// mispointed DATABASE_URL cannot corrupt real shadow rows or a real production index.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const MIGRATION_SQL_URL = new URL(
  '../../src/db/migrations/074_shadow_eval_idempotency.sql',
  import.meta.url,
);
// Test rows use source_message_id values under this prefix so cleanup never deletes real rows.
const PFX = 'itest-shadow-idem-';

/** Insert a pre-scored shadow row directly (bypassing the repo) with a scoped source id. */
async function insertShadow(pool: pg.Pool, src: string): Promise<number> {
  // `id` is BIGSERIAL; node-postgres returns int8 columns as strings (no global bigint
  // type-parser is registered in this codebase) to avoid silent precision loss on values
  // beyond Number.MAX_SAFE_INTEGER. Test ids never approach that range, so Number() is safe here.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO autonomy_action_log
       (task_id, skill_name, action_risk, outcome, payload, competence_flag, scored_by)
     VALUES ($1, 'shadow-draft-eval', 'none', 'shadow_evaluated', $2::jsonb, 1, 'shadow-reconciler')
     RETURNING id`,
    [`shadow:${src}`, JSON.stringify({ shadow: true, source_message_id: src })],
  );
  return Number(rows[0]!.id);
}

describeIf('migration 074: shadow-eval idempotency', () => {
  let pool: pg.Pool;
  let upSql: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // Safety rail: this suite runs the migration's UNSCOPED, table-wide dedup DELETE + CREATE INDEX,
    // so it must never touch a real database. Refuse to run unless connected to a *test* database —
    // a mispointed DATABASE_URL (e.g. prod) fails loudly HERE, before any DDL executes. (No shared
    // curia_test fixture exists in the repo yet; this in-file guard is the minimal safeguard.)
    const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db');
    const dbName = rows[0]!.db;
    if (!/test/i.test(dbName)) {
      await pool.end();
      throw new Error(
        `Refusing to run the destructive migration-074 integration test against database "${dbName}". ` +
          'Point DATABASE_URL at a test database (its name must contain "test").',
      );
    }
    const full = await readFile(MIGRATION_SQL_URL, 'utf8');
    // Run only the Up half — the Down's DROP INDEX would otherwise remove what we assert.
    upSql = full.split('-- Down Migration')[0]!;
  });

  // Clean slate: drop the index and delete only our scoped rows before each case. The index name is
  // a fixed literal (not interpolated) to keep the DDL out of the parameterized-query lint's sights.
  beforeEach(async () => {
    await pool.query('DROP INDEX IF EXISTS idx_aal_shadow_source');
    await pool.query(`DELETE FROM autonomy_action_log WHERE payload->>'source_message_id' LIKE $1`, [`${PFX}%`]);
  });

  afterAll(async () => {
    await pool.query('DROP INDEX IF EXISTS idx_aal_shadow_source');
    await pool.query(`DELETE FROM autonomy_action_log WHERE payload->>'source_message_id' LIKE $1`, [`${PFX}%`]);
    await pool.end();
  });

  it('deletes duplicate shadow rows (keeping the lowest id) before creating the index', async () => {
    const src = `${PFX}dup`;
    const id1 = await insertShadow(pool, src);
    const id2 = await insertShadow(pool, src);
    expect(id2).toBeGreaterThan(id1);

    await pool.query(upSql); // dedup + CREATE UNIQUE INDEX; must not abort on the pre-existing dup

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM autonomy_action_log WHERE payload->>'source_message_id' = $1`,
      [src],
    );
    expect(rows.map((r) => Number(r.id))).toEqual([id1]); // only the lowest-id row survives
  });

  it('rejects a duplicate shadow insert once the index exists', async () => {
    await pool.query(upSql);
    const src = `${PFX}unique`;
    await insertShadow(pool, src);
    await expect(insertShadow(pool, src)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('allows two shadow rows with different source ids', async () => {
    await pool.query(upSql);
    const a = await insertShadow(pool, `${PFX}a`);
    const b = await insertShadow(pool, `${PFX}b`);
    expect(a).not.toBe(b); // no false conflict across distinct source ids
  });
});
