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
export function up(pgm) {
  pgm.noTransaction();

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
