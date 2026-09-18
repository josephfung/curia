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

  /** `indisvalid` per index name, plus the OID, which changes if and only if the index was rebuilt. */
  async function indexState(): Promise<Map<string, { oid: string; valid: boolean }>> {
    const { rows } = await pool.query<{ relname: string; oid: string; indisvalid: boolean }>(
      `SELECT c.relname, c.oid::text AS oid, i.indisvalid
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'audit_log' AND c.relname = ANY($1)`,
      [INDEX_NAMES],
    );
    return new Map(rows.map((r) => [r.relname, { oid: r.oid, valid: r.indisvalid }]));
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

    // Manufacture a genuinely INVALID index under 081's name the way production would get one: a
    // CREATE INDEX CONCURRENTLY that fails during its table scan. Postgres leaves the index behind
    // marked invalid, exactly as after a deadlock or a killed deploy. Two audit rows sharing a
    // sentinel `action` make a unique build over that predicate fail deterministically.
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

  it('still drops all six, in reverse build order, on the way down', () => {
    // Collected, never executed — running it would drop audit_log's real indexes. `up()` and
    // `down()` are driven off one list, and this is what pins that they stay symmetric.
    const pgm = new MigrationBuilder(migrationDb, undefined, false, silentLogger);
    down(pgm);

    expect(pgm.isUsingTransaction()).toBe(false);
    expect(pgm.getSqlSteps()).toEqual([...INDEXES].reverse().map((i) => `${i.drop};`));
  });
});
