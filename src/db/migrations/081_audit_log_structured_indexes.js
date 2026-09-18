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
 *
 * ---
 *
 * OPERATOR REPAIR (#1808) — read this if an audit_log index is already INVALID.
 *
 * `up()` below drops and rebuilds an index left INVALID by a failed concurrent
 * build, but it only helps where it RUNS. Every deployment that has already
 * applied 081 has its row in `pgmigrations`, so the runner will not execute this
 * file again there — the guard protects fresh installs and any environment where
 * 081 is retried after a failure, not a database already carrying the damage.
 *
 * To find the damage (read-only, safe on prod — widen past audit_log by dropping
 * the `t.relname` clause):
 *
 *   SELECT n.nspname AS schema, t.relname AS table_name, c.relname AS index_name
 *     FROM pg_class c
 *     JOIN pg_index i ON i.indexrelid = c.oid
 *     JOIN pg_class t ON t.oid = i.indrelid
 *     JOIN pg_namespace n ON n.oid = c.relnamespace
 *    WHERE t.relname = 'audit_log' AND NOT i.indisvalid;
 *
 * To repair each row it returns — one at a time, OUTSIDE a transaction, since
 * neither statement can run inside one. Use the `schema` column the query
 * returns to qualify BOTH the index and the table: the detection query spans
 * every schema on purpose, but a bare name resolves through search_path, so an
 * unqualified repair can drop a healthy same-named index and rebuild it on the
 * wrong audit_log. Re-issue the index's own CREATE from INDEXES below, changing
 * nothing but the qualification:
 *
 *   DROP INDEX CONCURRENTLY IF EXISTS <schema>.<index_name>;
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_action
 *     ON <schema>.audit_log (action) WHERE action IS NOT NULL;
 *
 * On a single-schema deployment — which is every entry point this repo ships,
 * none of which passes --schema — <schema> is `public` for all six.
 *
 * Re-run the detection query afterwards: the rebuilt index must come back
 * `indisvalid = true`. If a repair is ever needed across the fleet rather than on
 * one host, that belongs in a new migration with the next free prefix — not in
 * an edit to this file, which those deployments will never re-run.
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
  //
  // Both statements below name their objects WITHOUT a schema, so each resolves through
  // search_path. A catalog read does not — it spans every schema — so the two clauses that look
  // redundant are what keep the read and the statements pointed at the same objects:
  //
  //   pg_table_is_visible(c.oid)      the index this DROP will resolve to
  //   i.indrelid = 'audit_log'::regclass   the table this CREATE will build on
  //
  // Drop either one and the check can match an index the statements cannot address. Without the
  // first, an invalid index of the same name on an audit_log in a schema OFF the path makes this
  // drop and rebuild the healthy, visible one while the invalid match survives. Without the
  // second, a multi-schema search_path (node-pg-migrate takes repeated --schema) can put the
  // visible invalid index on a different audit_log than the unqualified `ON audit_log` targets —
  // so the DROP removes a real index and the CREATE rebuilds it on the wrong table.
  //
  // The regclass cast is what makes that second clause exact: it resolves the bare name the same
  // way the CREATE does, to one OID. It subsumes a `t.relname = 'audit_log'` name match, which is
  // why there is no join to pg_class for the table.
  const invalid = await pgm.db.select(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ANY($1)
        AND i.indrelid = 'audit_log'::regclass
        AND pg_catalog.pg_table_is_visible(c.oid)
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
