-- Up Migration

-- 073_shadow_evaluated_outcome.sql
--
-- ADR-029 / #1426: terminal outcome for pre-scored shadow-draft competence rows.
-- Rows use scored_by = 'shadow-reconciler' so findUnscoredTerminal skips them
-- while findAllScored still includes them in the Phase 3 composite.

-- NOTE ON LOCKING (mirrors the convention documented in migration 044):
-- node-pg-migrate wraps each SQL migration file in a single transaction, so
-- `CREATE INDEX CONCURRENTLY` and a deferred `VALIDATE CONSTRAINT` are not available here
-- (both require running outside a transaction). Re-adding the CHECK and rebuilding the
-- partial index therefore take a brief table lock / scan on autonomy_action_log during
-- deploy. This is acceptable at the current single-tenant table size, matching how 044
-- handled the same tradeoff. If autonomy_action_log grows large enough that this stalls
-- writes, split this into a separate non-transactional migration using
-- `CREATE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... NOT VALID` followed by a later
-- `VALIDATE CONSTRAINT`.

ALTER TABLE autonomy_action_log
  DROP CONSTRAINT IF EXISTS autonomy_action_log_outcome_check;

ALTER TABLE autonomy_action_log
  ADD CONSTRAINT autonomy_action_log_outcome_check
  CHECK (outcome IN (
    'success', 'failure', 'rejected',
    'pending_approval', 'approved', 'denied', 'expired', 'resolved_externally',
    'shadow_evaluated'
  ));

DROP INDEX IF EXISTS idx_aal_unscored;
CREATE INDEX idx_aal_unscored
  ON autonomy_action_log (created_at)
  WHERE scored_by IS NULL
    AND outcome IN (
      'success', 'failure', 'rejected', 'approved', 'denied', 'expired',
      'resolved_externally', 'shadow_evaluated'
    );

-- Down Migration

DROP INDEX IF EXISTS idx_aal_unscored;
CREATE INDEX idx_aal_unscored
  ON autonomy_action_log (created_at)
  WHERE scored_by IS NULL
    AND outcome IN ('success', 'failure', 'rejected', 'approved', 'denied', 'expired', 'resolved_externally');

-- The restored constraint below does not allow 'shadow_evaluated'. Any such rows are
-- synthetic pre-scored competence rows written by this feature (scored_by =
-- 'shadow-reconciler'); once the feature is rolled back they carry no meaning, so remove
-- them before reinstating the constraint — otherwise ADD CONSTRAINT aborts on the
-- pre-existing violating rows and the downgrade cannot complete.
DELETE FROM autonomy_action_log WHERE outcome = 'shadow_evaluated';

ALTER TABLE autonomy_action_log
  DROP CONSTRAINT IF EXISTS autonomy_action_log_outcome_check;

ALTER TABLE autonomy_action_log
  ADD CONSTRAINT autonomy_action_log_outcome_check
  CHECK (outcome IN (
    'success', 'failure', 'rejected',
    'pending_approval', 'approved', 'denied', 'expired', 'resolved_externally'
  ));
