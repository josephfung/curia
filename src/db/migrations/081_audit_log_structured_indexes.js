/**
 * 081 — Concurrent indexes for Phase 1 audit hardening columns + seq.
 *
 * Plain JS (not SQL/TS) on purpose:
 * - node-pg-migrate wraps `.sql` files in a transaction → forbids
 *   `CREATE INDEX CONCURRENTLY`
 * - A `.js` wrapper can call `pgm.noTransaction()` and is loadable via
 *   dynamic `import()` under both `tsx` (CLI migrate / install.sh / CI) and
 *   the boot-time programmatic runner — without needing TypeScript compilation
 *
 * Migration name recorded in pgmigrations is the basename without extension
 * (`081_audit_log_structured_indexes`), so renaming from `.ts` → `.js` does
 * not re-apply on DBs that already ran the TypeScript version.
 *
 * Safe against DBs that built these indexes under the original transactional
 * CREATE INDEX in 078/080 (`IF NOT EXISTS`).
 */

/**
 * The six indexes this migration owns, in build order.
 *
 * `drop` is spelled out rather than built from `name` so every SQL string in this file stays a
 * fixed literal: an index name cannot be bound as a query parameter in DDL, and the repo's rule
 * is that variables never reach a SQL string. `down()` reverses this list, so the two halves
 * cannot drift apart.
 */
const INDEXES = [
  {
    name: 'idx_audit_action',
    drop: `DROP INDEX CONCURRENTLY IF EXISTS idx_audit_action`,
    create: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_action
        ON audit_log (action)
        WHERE action IS NOT NULL
    `,
  },
  {
    name: 'idx_audit_outcome',
    drop: `DROP INDEX CONCURRENTLY IF EXISTS idx_audit_outcome`,
    create: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_outcome
        ON audit_log (outcome)
        WHERE outcome IS NOT NULL
    `,
  },
  {
    name: 'idx_audit_target',
    drop: `DROP INDEX CONCURRENTLY IF EXISTS idx_audit_target`,
    create: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_target
        ON audit_log (target_type, target_id)
        WHERE target_type IS NOT NULL
    `,
  },
  {
    name: 'idx_audit_initiator',
    drop: `DROP INDEX CONCURRENTLY IF EXISTS idx_audit_initiator`,
    create: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_initiator
        ON audit_log (initiator_type, initiator_id)
        WHERE initiator_type IS NOT NULL
    `,
  },
  {
    // task_id already exists (migration 001) but was under-indexed; readers historically
    // filtered via payload->>'taskId' (idx from 071). Index the column for new rows that
    // populate it, while keeping the payload expression index for legacy rows.
    name: 'idx_audit_task_id',
    drop: `DROP INDEX CONCURRENTLY IF EXISTS idx_audit_task_id`,
    create: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_task_id
        ON audit_log (task_id)
        WHERE task_id IS NOT NULL
    `,
  },
  {
    name: 'idx_audit_log_seq',
    drop: `DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_seq`,
    create: `
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_seq
        ON audit_log (seq)
    `,
  },
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.noTransaction();

  // A CREATE INDEX CONCURRENTLY that fails partway (deadlock, cancelled session, a crashed
  // deploy) leaves the index behind marked INVALID: unusable for queries, still maintained on
  // every write. On the retry, IF NOT EXISTS would see the name, skip the build, and report
  // success — leaving audit_log, the largest table in the schema and written on every bus
  // publish, with the write cost of six indexes and none of the benefit. Drop those carcasses
  // first. The check is narrow on purpose: only an index that BOTH exists and is invalid is
  // dropped, so a healthy one is never rebuilt (#1808, mirroring 087).
  //
  // One round trip for all six rather than six: node-pg-migrate awaits `up()` in full before it
  // runs a single queued `pgm.sql()` step, so every check reads pre-migration state regardless
  // of how they are batched — and nothing this migration does can invalidate an index mid-run
  // (a failed CREATE aborts the migration outright).
  const invalid = await pgm.db.select(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = 'audit_log'
        AND c.relname = ANY($1)
        AND NOT i.indisvalid`,
    [INDEXES.map((index) => index.name)],
  );
  const invalidNames = new Set(invalid.map((row) => row.relname));

  for (const index of INDEXES) {
    // DROP INDEX CONCURRENTLY cannot run inside a transaction or a DO block, which is the other
    // reason this migration is .js with noTransaction() rather than plain .sql.
    if (invalidNames.has(index.name)) pgm.sql(index.drop);
    pgm.sql(index.create);
  }
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.noTransaction();

  // Reverse build order, as before. Driven off INDEXES so a future index added to `up()` cannot
  // be forgotten here.
  for (const index of [...INDEXES].reverse()) pgm.sql(index.drop);
}
