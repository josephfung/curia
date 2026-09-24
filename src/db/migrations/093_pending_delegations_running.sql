-- Up Migration: claim a specialist at dispatch time (#1893)
--
-- pending_delegations used to exist only after a delegate wait expired. Two turns can
-- overlap inside that wait — nothing serializes coordinator turns per conversation — so
-- both published a specialist run. A `running` row is written when the specialist task
-- is published and deleted when that wait returns. Timeout promotes the same row to
-- `pending` (the #1858 handle) instead of inserting a second one.
--
-- One running row per specialist per originating conversation. The partial unique index
-- is what makes the claim atomic: INSERT ... ON CONFLICT DO NOTHING, not check-then-write.
-- expires_at on a running row is the delegate wait (plus a short grace), so a crashed
-- process stops blocking when the sweep next sees it, not an hour later.

ALTER TABLE pending_delegations DROP CONSTRAINT IF EXISTS pending_delegations_status_check;

-- Postgres stores `CHECK (status IN (...))` as `status = ANY (ARRAY[...])`, so a
-- match on the source text `status IN (` never finds the constraint. Drop any
-- remaining status-membership check that does not already allow `running`
-- (a restored dump may have renamed the default `pending_delegations_status_check`).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'pending_delegations'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status = ANY (%'
       AND pg_get_constraintdef(con.oid) NOT ILIKE '%running%'
  LOOP
    EXECUTE format('ALTER TABLE pending_delegations DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE pending_delegations
  ADD CONSTRAINT pending_delegations_status_check
  CHECK (status IN ('running', 'pending', 'claimed', 'resolved'));

ALTER TABLE pending_delegations DROP CONSTRAINT pending_delegations_resolution_shape;
ALTER TABLE pending_delegations
  ADD CONSTRAINT pending_delegations_resolution_shape CHECK (
    (status = 'running'  AND resolution IS NULL     AND claimed_at IS NULL     AND claim_token IS NULL     AND resolved_at IS NULL) OR
    (status = 'pending'  AND resolution IS NULL     AND claimed_at IS NULL     AND claim_token IS NULL     AND resolved_at IS NULL) OR
    (status = 'claimed'  AND resolution IS NOT NULL AND claimed_at IS NOT NULL AND claim_token IS NOT NULL AND resolved_at IS NULL) OR
    (status = 'resolved' AND resolution IS NOT NULL AND claimed_at IS NOT NULL AND claim_token IS NOT NULL AND resolved_at IS NOT NULL)
  );

-- The #1858 lookup now matches a dispatch claim and a post-timeout handle.
DROP INDEX IF EXISTS idx_pending_delegations_in_flight;
CREATE INDEX idx_pending_delegations_in_flight
  ON pending_delegations (target_agent, origin_conversation_id, created_at)
  WHERE status IN ('pending', 'running');

CREATE UNIQUE INDEX idx_pending_delegations_one_running
  ON pending_delegations (target_agent, origin_conversation_id)
  WHERE status = 'running';

-- Fail the migration if a status check that does not mention `running` survived.
-- Otherwise every acquire would violate the old check at runtime and delegation
-- would refuse to dispatch with no signal here.
DO $$
DECLARE def text;
BEGIN
  FOR def IN
    SELECT pg_get_constraintdef(con.oid)
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'pending_delegations'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    IF def NOT ILIKE '%running%' THEN
      RAISE EXCEPTION 'pending_delegations status check still rejects running: %', def;
    END IF;
  END LOOP;
END $$;

-- The sweep walks expired running claims the same way it walks pending handles.
DROP INDEX IF EXISTS idx_pending_delegations_open;
CREATE INDEX idx_pending_delegations_open
  ON pending_delegations (expires_at)
  WHERE status IN ('running', 'pending', 'claimed');

-- Rollback:
-- DROP INDEX IF EXISTS idx_pending_delegations_one_running;
-- DROP INDEX IF EXISTS idx_pending_delegations_in_flight;
-- CREATE INDEX idx_pending_delegations_in_flight
--   ON pending_delegations (target_agent, origin_conversation_id, created_at)
--   WHERE status = 'pending';
-- DROP INDEX IF EXISTS idx_pending_delegations_open;
-- CREATE INDEX idx_pending_delegations_open
--   ON pending_delegations (expires_at)
--   WHERE status IN ('pending', 'claimed');
-- ALTER TABLE pending_delegations DROP CONSTRAINT pending_delegations_resolution_shape;
-- ALTER TABLE pending_delegations DROP CONSTRAINT pending_delegations_status_check;
-- (restore the 086 CHECKs — only after every running row is gone)
