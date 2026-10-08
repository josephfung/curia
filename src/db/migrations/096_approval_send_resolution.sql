-- 096_approval_send_resolution.sql
--
-- A hinted send approval records the identity row and the name that was
-- resolved, separate from the skill payload. Replay refuses the send when
-- either no longer matches, so a removed label cannot fall through to a
-- different unlabelled address (#2047, ADR-047).

-- Up Migration

ALTER TABLE autonomy_action_log
  ADD COLUMN send_resolution JSONB;

-- Down Migration

ALTER TABLE autonomy_action_log
  DROP COLUMN IF EXISTS send_resolution;
