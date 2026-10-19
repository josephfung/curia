// Integration test — runs migration 098's Up and Down SQL against a live Postgres and asserts
// the approval_number column and its partial index appear on up, disappear on down, and come
// back on a second up (#2159 Phase 3). Skips without DATABASE_URL.
//
// The whole case runs inside one transaction that is rolled back (Postgres DDL is
// transactional), so the test database's schema is the same afterwards whether or not the
// migration had already been applied. It still alters a table, so it refuses any database but
// curia_test first.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const MIGRATION_SQL_URL = new URL('../../src/db/migrations/098_approval_number.sql', import.meta.url);
const INDEX_NAME = 'idx_aal_approval_number';

describeIf('migration 098: approval_number on autonomy_action_log', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let upSql: string;
  let downSql: string;

  async function columnType(): Promise<string | undefined> {
    const { rows } = await client.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'autonomy_action_log' AND column_name = 'approval_number'`,
    );
    return rows[0]?.data_type;
  }

  async function indexDef(): Promise<string | undefined> {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'autonomy_action_log' AND indexname = $1`,
      [INDEX_NAME],
    );
    return rows[0]?.indexdef;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // Before any case opens a transaction. afterAll still runs if this throws, and only
    // closes the pool.
    await requireCuriaTestDatabase(pool);
    const sql = await readFile(MIGRATION_SQL_URL, 'utf8');
    const [up, down] = sql.split('-- Down Migration');
    upSql = up!;
    downSql = down!;
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    // The test database may already be migrated past 098. Down is idempotent (IF EXISTS), so
    // it gives every case a clean slate; the rollback in afterEach restores the real state.
    await client.query(downSql);
  });

  afterEach(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('up adds a nullable SMALLINT column and a partial index on non-null numbers', async () => {
    expect(await columnType()).toBeUndefined();
    expect(await indexDef()).toBeUndefined();

    await client.query(upSql);

    expect(await columnType()).toBe('smallint');
    const def = await indexDef();
    expect(def).toBeDefined();
    expect(def).toContain('(approval_number, created_at)');
    expect(def).toMatch(/WHERE \(?approval_number IS NOT NULL\)?/);

    // Nullable: a row that is not an approval carries no number.
    const { rows } = await client.query<{ approval_number: number | null }>(
      `INSERT INTO autonomy_action_log (task_id, skill_name, action_risk, outcome)
       VALUES ('itest-approval-number', 'itest-skill', 'none', 'success')
       RETURNING approval_number`,
    );
    expect(rows[0]!.approval_number).toBeNull();
  });

  it('down removes the index and the column', async () => {
    await client.query(upSql);
    await client.query(downSql);

    expect(await indexDef()).toBeUndefined();
    expect(await columnType()).toBeUndefined();
  });

  it('up, down, then up again leaves the column and index in place', async () => {
    await client.query(upSql);
    await client.query(downSql);
    await client.query(upSql);

    expect(await columnType()).toBe('smallint');
    expect(await indexDef()).toBeDefined();
  });
});
