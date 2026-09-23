-- Up Migration
-- voice_sessions.principal_contact_id stores the resolved caller contact id,
-- including non-principal callers (Signal unknown-sender allow, #1672).
-- Rename so the column matches its contents (#1629).
--
-- RENAME COLUMN preserves existing rows and the FK from migration 082
-- (ON DELETE SET NULL). Do not drop and recreate the column.

ALTER TABLE voice_sessions
  RENAME COLUMN principal_contact_id TO caller_contact_id;

-- Down Migration

ALTER TABLE voice_sessions
  RENAME COLUMN caller_contact_id TO principal_contact_id;
