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

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function up(pgm) {
  pgm.noTransaction();

  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_action
      ON audit_log (action)
      WHERE action IS NOT NULL
  `);
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_outcome
      ON audit_log (outcome)
      WHERE outcome IS NOT NULL
  `);
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_target
      ON audit_log (target_type, target_id)
      WHERE target_type IS NOT NULL
  `);
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_initiator
      ON audit_log (initiator_type, initiator_id)
      WHERE initiator_type IS NOT NULL
  `);
  // task_id already exists (migration 001) but was under-indexed; readers historically
  // filtered via payload->>'taskId' (idx from 071). Index the column for new rows that
  // populate it, while keeping the payload expression index for legacy rows.
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_task_id
      ON audit_log (task_id)
      WHERE task_id IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_seq
      ON audit_log (seq)
  `);
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.noTransaction();

  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_seq`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_task_id`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_initiator`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_target`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_outcome`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_audit_action`);
}
