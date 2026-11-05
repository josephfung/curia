/**
 * 118 — Partial index for per-secret usage (console Secrets page).
 *
 * SecretUsageRepo reads secret.accessed rows grouped by payload->>'secretName' (last used) and
 * newest-first for one name (recent uses). idx_audit_log_secret_accessed holds exactly those rows,
 * keyed by name then time, so neither query scans the log.
 *
 * No backfill: the repo reads payload->>'secretName', which old and new rows both carry, and
 * audit_log is append-only (a backfill would need the trigger disabled).
 *
 * Plain JS with pgm.noTransaction(), mirroring 105: CREATE INDEX CONCURRENTLY cannot run in the
 * transaction node-pg-migrate wraps `.sql` files in, and a blocking build would hold a write lock
 * on audit_log — the write-ahead hook behind every bus publish — for the whole build.
 */

const INDEX = {
  name: 'idx_audit_log_secret_accessed',
  sql: `ON audit_log ((payload->>'secretName'), timestamp DESC)
        WHERE event_type = 'secret.accessed'`,
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.noTransaction();

  // A failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would then skip
  // (see 087). Drop only an invalid one, so a healthy index is never rebuilt.
  const invalid = await pgm.db.select(
    `SELECT 1 FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND NOT i.indisvalid`,
    [INDEX.name],
  );
  if (invalid.length > 0) {
    pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX.name}`);
  }
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX.name} ${INDEX.sql}`);
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX.name}`);
}
