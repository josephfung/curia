// Integration test — drives migration 081's `up()` against a live Postgres and asserts the
// INVALID-index recovery from #1808. Skips without DATABASE_URL.
//
// 081 builds six indexes on audit_log with CREATE INDEX CONCURRENTLY IF NOT EXISTS. A concurrent
// build that fails partway leaves the index behind marked invalid — ignored by the planner, still
// maintained on every write — and IF NOT EXISTS would then see the name on the retry, skip the
// build, and report success. These cases pin both halves of the fix: an invalid index is dropped
// and genuinely rebuilt, and a healthy one is left strictly alone.
//
// This suite DROPS and REBUILDS the real audit_log indexes, so it must never run anywhere but the
// isolated curia_test database — hence requireCuriaTestDatabase and the onTestDb gate below.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { MigrationBuilder } from 'node-pg-migrate';
import { db as createMigrationDb, type DBConnection } from 'node-pg-migrate/db';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const MIGRATION_URL = new URL(
  '../../src/db/migrations/081_audit_log_structured_indexes.js',
  import.meta.url,
);

// The six indexes 081 owns, in the order it builds them. Each `drop` is a fixed literal rather
// than a name interpolated into DDL, matching the migration and the repo's no-variables-in-SQL rule.
const INDEXES = [
  { name: 'idx_audit_action', drop: 'DROP INDEX CONCURRENTLY IF EXISTS idx_audit_action' },
  { name: 'idx_audit_outcome', drop: 'DROP INDEX CONCURRENTLY IF EXISTS idx_audit_outcome' },
  { name: 'idx_audit_target', drop: 'DROP INDEX CONCURRENTLY IF EXISTS idx_audit_target' },
  { name: 'idx_audit_initiator', drop: 'DROP INDEX CONCURRENTLY IF EXISTS idx_audit_initiator' },
  { name: 'idx_audit_task_id', drop: 'DROP INDEX CONCURRENTLY IF EXISTS idx_audit_task_id' },
  { name: 'idx_audit_log_seq', drop: 'DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_seq' },
] as const;
const INDEX_NAMES = INDEXES.map((i) => i.name);

// Sentinel values for the two rows this suite appends to audit_log, so they are identifiable
// later. audit_log is append-only (migration 021's trigger blocks DELETE), so they stay — the
// same accounting every audit_log integration suite in this repo already makes.
const SENTINEL_ACTION = 'itest-081-invalid-index';
const SENTINEL_LAYER = 'test-migration-081';

/** The migration is plain `.js` with no declarations; a computed-URL import keeps tsc out of it. */
type MigrationModule = {
  up: (pgm: MigrationBuilder) => Promise<void> | void;
  down: (pgm: MigrationBuilder) => void;
};

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describeIf('migration 081: invalid-index recovery', () => {
  let pool: pg.Pool;
  let client: pg.Client;
  let migrationDb: DBConnection;
  let up: MigrationModule['up'];
  let down: MigrationModule['down'];
  // Set only after requireCuriaTestDatabase confirms curia_test. vitest still fires afterAll after
  // a FAILED beforeAll, so without this flag a guard abort against a mispointed DATABASE_URL would
  // still run the teardown's DROP INDEX — against real production indexes.
  let onTestDb = false;

  /**
   * Run 081's `up()` the way node-pg-migrate does: await the whole function first (so every
   * `pgm.db.select()` it performs has already run), then execute the queued `pgm.sql()` steps in
   * order. That ordering is the contract the migration's batched invalidity check relies on, so
   * the real MigrationBuilder drives it rather than a stand-in that would encode the assumption
   * instead of testing it.
   */
  async function runUp(): Promise<{ steps: string[]; transactional: boolean }> {
    const pgm = new MigrationBuilder(migrationDb, undefined, false, silentLogger);
    await up(pgm);
    const steps = pgm.getSqlSteps();
    const transactional = pgm.isUsingTransaction();
    // Guard, not just an assertion: every step here is CONCURRENTLY, which errors outright inside
    // a transaction. Fail loudly rather than run the suite in a shape the migration never uses.
    if (transactional) throw new Error('081 must call pgm.noTransaction() — refusing to run');
    for (const sql of steps) await migrationDb.query(sql);
    return { steps, transactional };
  }

  /**
   * `indisvalid` per index name, plus the OID, which changes if and only if the index was rebuilt.
   * Scoped to search-path-visible indexes, like the migration — otherwise the shadow-schema case
   * below would collapse two same-named rows into one and the Map would report whichever came last.
   */
  async function indexState(): Promise<Map<string, { oid: string; valid: boolean }>> {
    const { rows } = await pool.query<{ relname: string; oid: string; indisvalid: boolean }>(
      `SELECT c.relname, c.oid::text AS oid, i.indisvalid
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'audit_log'
          AND c.relname = ANY($1)
          AND pg_catalog.pg_table_is_visible(c.oid)`,
      [INDEX_NAMES],
    );
    return new Map(rows.map((r) => [r.relname, { oid: r.oid, valid: r.indisvalid }]));
  }

  /**
   * Leave public.idx_audit_action INVALID, the way a killed concurrent build would: a
   * CREATE INDEX CONCURRENTLY that fails during its table scan. Postgres leaves the index behind
   * marked invalid, exactly as after a deadlock or a crashed deploy. Two audit rows sharing a
   * sentinel `action` make a unique build over that predicate fail deterministically.
   */
  async function breakActionIndex(): Promise<void> {
    await pool.query(
      `INSERT INTO audit_log (event_type, source_layer, source_id, payload, action)
       VALUES ('inbound.message', $1, 'itest', '{}', $2),
              ('inbound.message', $1, 'itest', '{}', $2)`,
      [SENTINEL_LAYER, SENTINEL_ACTION],
    );
    await pool.query('DROP INDEX CONCURRENTLY IF EXISTS idx_audit_action');
    const failure = await pool
      .query(
        `CREATE UNIQUE INDEX CONCURRENTLY idx_audit_action
           ON audit_log (action)
           WHERE action = 'itest-081-invalid-index'`,
      )
      .then(
        () => undefined,
        (error: unknown) => error as { code?: string },
      );
    expect(failure?.code).toBe('23505'); // unique_violation — the build failed, as designed
  }

  async function indexDefinition(name: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_log' AND indexname = $1`,
      [name],
    );
    return rows[0]?.indexdef;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // Safety rail: this suite drops and rebuilds audit_log's real indexes. The shared guard throws
    // HERE — before onTestDb is set and before any DDL — if DATABASE_URL is not curia_test.
    await requireCuriaTestDatabase(pool);
    onTestDb = true;

    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    migrationDb = createMigrationDb(client, silentLogger);

    ({ up, down } = (await import(MIGRATION_URL.href)) as MigrationModule);

    // Start from the state the migration itself produces, so the healthy-path case does not
    // depend on what earlier suites left behind.
    await runUp();
  }, 60_000);

  afterAll(async () => {
    if (onTestDb) {
      // Leave audit_log as found: drop anything this suite left invalid, then rebuild all six.
      const state = await indexState();
      for (const index of INDEXES) {
        if (state.get(index.name)?.valid === false) await migrationDb.query(index.drop);
      }
      await runUp();
    }
    if (migrationDb) await migrationDb.close();
    if (client) await client.end();
    if (pool) await pool.end();
  }, 60_000);

  it('leaves healthy indexes alone — issues no DROP and rebuilds nothing', async () => {
    const before = await indexState();
    expect([...before.keys()].sort()).toEqual([...INDEX_NAMES].sort());
    expect([...before.values()].every((s) => s.valid)).toBe(true);

    const { steps, transactional } = await runUp();

    expect(transactional).toBe(false);
    // No DROP at all when every index is valid. The narrow check is what keeps a re-run from
    // rebuilding a healthy index on the largest table in the schema.
    expect(steps.filter((s) => /DROP INDEX/i.test(s))).toEqual([]);
    expect(steps).toHaveLength(INDEXES.length);

    // And the OIDs prove it: a drop-and-rebuild would mint new ones.
    const after = await indexState();
    for (const name of INDEX_NAMES) {
      expect(after.get(name)?.oid).toBe(before.get(name)?.oid);
      expect(after.get(name)?.valid).toBe(true);
    }
  }, 60_000);

  it('drops an invalid index and rebuilds it to the definition 081 specifies', async () => {
    const wanted = await indexDefinition('idx_audit_action');
    const before = await indexState();

    await breakActionIndex();

    // Precondition: the name is taken by an index the planner cannot use. Without the fix, 081's
    // IF NOT EXISTS stops here and the migration reports success.
    const broken = await indexState();
    expect(broken.get('idx_audit_action')?.valid).toBe(false);

    const { steps, transactional } = await runUp();

    expect(transactional).toBe(false);
    // Exactly one DROP, for the one broken index — the other five are healthy and untouched.
    // (pgm.sql() appends the statement terminator, hence the trailing semicolon.)
    expect(steps.filter((s) => /DROP INDEX/i.test(s))).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS idx_audit_action;',
    ]);

    const after = await indexState();
    expect(after.get('idx_audit_action')?.valid).toBe(true);
    // A new OID and 081's own definition: the carcass is gone and this is a real rebuild, not the
    // unique sentinel index surviving with its flag flipped.
    expect(after.get('idx_audit_action')?.oid).not.toBe(broken.get('idx_audit_action')?.oid);
    expect(await indexDefinition('idx_audit_action')).toBe(wanted);

    // The five healthy indexes kept their OIDs across both the breakage and the recovery run.
    for (const name of INDEX_NAMES.filter((n) => n !== 'idx_audit_action')) {
      expect(after.get(name)?.oid).toBe(before.get(name)?.oid);
      expect(after.get(name)?.valid).toBe(true);
    }
  }, 60_000);

  it('ignores an invalid same-named index on an audit_log outside the search path', async () => {
    // `DROP INDEX <name>` resolves through search_path, but a catalog read does not — it spans
    // every schema. So an unfiltered check can match an invalid index the DROP would never reach,
    // and the DROP then lands on the healthy visible one instead: a rebuild of a good index while
    // the broken one survives. The migration filters on pg_table_is_visible; this is that case.
    const before = await indexState();
    try {
      // Every statement a fixed literal — a schema name cannot be bound as a query parameter
      // either, and the repo's rule is that no variable reaches a SQL string.
      await pool.query('CREATE SCHEMA itest_081_shadow');
      await pool.query('CREATE TABLE itest_081_shadow.audit_log (action TEXT)');
      await pool.query("INSERT INTO itest_081_shadow.audit_log (action) VALUES ('dupe'), ('dupe')");
      // Same failed-unique-build trick, on a table we own: leaves the shadow schema's
      // idx_audit_action invalid. That schema is off the search path, so an unqualified
      // `DROP INDEX idx_audit_action` can never resolve to it.
      const failure = await pool
        .query(
          `CREATE UNIQUE INDEX CONCURRENTLY idx_audit_action
             ON itest_081_shadow.audit_log (action)`,
        )
        .then(
          () => undefined,
          (error: unknown) => error as { code?: string },
        );
      expect(failure?.code).toBe('23505');

      // Precondition: two indexes share the name — public's healthy and visible, the shadow's
      // invalid and not.
      const { rows } = await pool.query<{ nspname: string; indisvalid: boolean; visible: boolean }>(
        `SELECT n.nspname, i.indisvalid, pg_catalog.pg_table_is_visible(c.oid) AS visible
           FROM pg_class c
           JOIN pg_index i ON i.indexrelid = c.oid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'idx_audit_action'
          ORDER BY n.nspname`,
      );
      expect(rows).toEqual([
        { nspname: 'itest_081_shadow', indisvalid: false, visible: false },
        { nspname: 'public', indisvalid: true, visible: true },
      ]);

      const { steps } = await runUp();

      // No DROP: the only invalid match is one this migration could not have addressed anyway.
      expect(steps.filter((s) => /DROP INDEX/i.test(s))).toEqual([]);

      const after = await indexState();
      expect(after.get('idx_audit_action')?.oid).toBe(before.get('idx_audit_action')?.oid);
      expect(after.get('idx_audit_action')?.valid).toBe(true);
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS itest_081_shadow CASCADE');
    }
  }, 60_000);

  it('ignores a visible invalid index sitting on a different audit_log than the CREATE targets', async () => {
    // node-pg-migrate takes repeated --schema, so search_path can hold more than one schema. Then
    // the visible `idx_audit_action` and the table an unqualified `ON audit_log` resolves to can
    // live in DIFFERENT schemas — and the DROP/CREATE pair would remove a real index and rebuild
    // it on the wrong table, leaving the original audit_log with no index at all. The migration
    // pins the check with `i.indrelid = 'audit_log'::regclass`, which resolves the bare name
    // exactly as the CREATE does. Visibility alone does not catch this: the invalid index IS
    // visible here.
    const originalPath = (
      (await migrationDb.select('SHOW search_path')) as Array<{ search_path: string }>
    )[0]!.search_path;
    try {
      await breakActionIndex();
      await pool.query('CREATE SCHEMA itest_081_sp');
      await pool.query('CREATE TABLE itest_081_sp.audit_log (action TEXT)');
      // Ahead of public in the path and carrying no idx_audit_action of its own, so public's
      // invalid index stays visible while a bare `audit_log` now resolves to the shadow table.
      await migrationDb.query('SET search_path TO itest_081_sp, public');

      // Precondition, read through the migration's own connection: the invalid index is visible
      // (so the DROP would reach it) but its table is NOT the one the CREATE would build on.
      const [precondition] = (await migrationDb.select(
        `SELECT i.indisvalid,
                pg_catalog.pg_table_is_visible(c.oid) AS visible,
                i.indrelid = 'audit_log'::regclass AS on_create_target,
                (SELECT n2.nspname FROM pg_class c2
                   JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                  WHERE c2.oid = 'audit_log'::regclass) AS create_target_schema
           FROM pg_class c
           JOIN pg_index i ON i.indexrelid = c.oid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'idx_audit_action' AND n.nspname = 'public'`,
      )) as Array<{
        indisvalid: boolean;
        visible: boolean;
        on_create_target: boolean;
        create_target_schema: string;
      }>;
      expect(precondition).toEqual({
        indisvalid: false,
        visible: true,
        on_create_target: false,
        create_target_schema: 'itest_081_sp',
      });

      // Collected, never executed — the assertion is about which statements up() decides to emit,
      // and running six CREATEs against the shadow table would prove nothing.
      const pgm = new MigrationBuilder(migrationDb, undefined, false, silentLogger);
      await up(pgm);
      expect(pgm.getSqlSteps().filter((s) => /DROP INDEX/i.test(s))).toEqual([]);
    } finally {
      // Order matters: restore the path first so the repair below targets public, not the shadow.
      await migrationDb.query(`SET search_path TO ${originalPath}`);
      await pool.query('DROP SCHEMA IF EXISTS itest_081_sp CASCADE');
      await pool.query('DROP INDEX CONCURRENTLY IF EXISTS idx_audit_action');
      await runUp();
    }

    const after = await indexState();
    expect(after.get('idx_audit_action')?.valid).toBe(true);
  }, 60_000);

  it('still drops all six, in reverse build order, on the way down', () => {
    // Collected, never executed — running it would drop audit_log's real indexes. `up()` and
    // `down()` are driven off one list, and this is what pins that they stay symmetric.
    const pgm = new MigrationBuilder(migrationDb, undefined, false, silentLogger);
    down(pgm);

    expect(pgm.isUsingTransaction()).toBe(false);
    expect(pgm.getSqlSteps()).toEqual([...INDEXES].reverse().map((i) => `${i.drop};`));
  });
});
