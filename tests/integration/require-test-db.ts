// Shared safety guard for destructive integration suites.
//
// Some integration tests run UNSCOPED, table-wide DDL/DML — e.g. the migration-074 idempotency
// suite executes the migration's own dedup `DELETE` and `CREATE UNIQUE INDEX` against the whole
// `autonomy_action_log` table. A mispointed `DATABASE_URL` (staging, prod, a personal DB) must fail
// LOUDLY before any such statement runs, never silently mutate real data.
//
// Per the repo convention (learning from #1429): `DATABASE_URL` presence stays the execution GATE
// (`describeIf` / `describe.skip`); database-NAME enforcement, when a destructive suite needs it,
// lives here in ONE shared helper rather than as a one-off guard copied into each test file. The
// match is EXACT — a substring/regex check (e.g. `/test/i`) would wave through databases like
// `production_test`, `contest`, or `customer-testing`.
import type pg from 'pg';

/**
 * The canonical isolated integration-test database name. CI's Postgres service (`.github/workflows/
 * ci.yml`, `dast.yml`) and the local `curia-test-pg` container both provision exactly this name.
 */
export const CURIA_TEST_DB = 'curia_test';

/**
 * Throw unless `pool` is connected to the canonical `curia_test` database. Call this in `beforeAll`,
 * before any destructive statement. Uses `current_database()` (the database actually connected to)
 * rather than parsing `DATABASE_URL`, so it reflects the real target even if the connection string
 * resolves somewhere unexpected.
 */
export async function requireCuriaTestDatabase(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db');
  const dbName = rows[0]?.db;
  if (dbName !== CURIA_TEST_DB) {
    throw new Error(
      `Refusing to run a destructive integration test against database "${dbName ?? '<unknown>'}". ` +
        `Point DATABASE_URL at the isolated "${CURIA_TEST_DB}" database.`,
    );
  }
}
