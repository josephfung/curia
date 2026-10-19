-- Up Migration
-- 098_approval_number.sql (#2159 Phase 3)
-- A small number the principal types to answer an approval ("approve 3"), in place of the
-- 8-character short_ref. Allocated at insert as the lowest number no approval used in the last
-- 7 days, under an advisory lock (ActionLogRepo.insert). Approvals expire within 48h, so a late
-- reply cannot reach a newer approval that reused the number. NULL on non-approval rows and on
-- approvals raised before this migration (those keep their short_ref).
ALTER TABLE autonomy_action_log ADD COLUMN approval_number SMALLINT;
CREATE INDEX idx_aal_approval_number ON autonomy_action_log (approval_number, created_at)
  WHERE approval_number IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_aal_approval_number;
ALTER TABLE autonomy_action_log DROP COLUMN IF EXISTS approval_number;
