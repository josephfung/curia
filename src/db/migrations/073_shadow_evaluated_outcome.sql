-- Up Migration

-- 073_shadow_evaluated_outcome.sql
--
-- ADR-029 / #1426: terminal outcome for pre-scored shadow-draft competence rows.
-- Rows use scored_by = 'shadow-reconciler' so findUnscoredTerminal skips them
-- while findAllScored still includes them in the Phase 3 composite.

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
