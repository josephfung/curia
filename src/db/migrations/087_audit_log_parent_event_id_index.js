/**
 * 087 — Index audit_log.parent_event_id (#1799).
 *
 * The column has existed since migration 001 but was never indexed, so every reader that
 * walks the causal chain sequentially scans the whole table — the largest one in the schema.
 * Two callers need it now:
 *
 *   - LateDelegationSweep, which asks "has the abandoned specialist for this handle responded?"
 *     on every tick (findLateResponseInAuditLog). Unindexed, that is one full scan per open
 *     handle per tick.
 *   - AuditLogRepo.getChildren(), the existing timeline reader, which has the same shape.
 *
 * Plain JS with pgm.noTransaction(), mirroring 081: node-pg-migrate wraps `.sql` files in a
 * transaction, which forbids CREATE INDEX CONCURRENTLY — and a non-concurrent build would take
 * a write lock on audit_log for the duration, blocking the write-ahead audit hook (i.e. every
 * bus publish) on a deployment with real history.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.noTransaction();

  // A CREATE INDEX CONCURRENTLY that fails partway (deadlock, cancelled session, a crashed
  // deploy) leaves the index behind marked INVALID: unusable for queries, still maintained on
  // every write. On the retry, IF NOT EXISTS would see the name, skip the build, and report
  // success — leaving audit_log with the write cost of an index and none of the benefit. Drop
  // that carcass first. The check is narrow on purpose: only an invalid index is dropped, so a
  // healthy one is never rebuilt.
  const invalid = await pgm.db.select(`
    SELECT 1 FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'idx_audit_log_parent_event_id' AND NOT i.indisvalid
  `);
  if (invalid.length > 0) {
    // DROP INDEX CONCURRENTLY cannot run inside a transaction or a DO block, which is the other
    // reason this migration is .js with noTransaction() rather than plain .sql.
    pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_parent_event_id`);
  }

  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_parent_event_id
      ON audit_log (parent_event_id)
      WHERE parent_event_id IS NOT NULL
  `);
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.noTransaction();

  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_parent_event_id`);
}
