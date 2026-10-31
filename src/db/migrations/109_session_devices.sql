-- 109_session_devices.sql
--
-- Device identity for console sessions (#2341, ADR-055). Existing rows are
-- browser logins: kind defaults to 'browser'. name and user_agent stay null
-- until the next throttled renewal, which fills them when the browser sends
-- a user agent. A later sign-in is a new row. paired_device is minted by
-- phone pairing.

-- Up Migration

ALTER TABLE sessions
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser',
  ADD COLUMN name TEXT,
  ADD COLUMN user_agent TEXT;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_kind_check CHECK (kind IN ('browser', 'paired_device'));

ALTER TABLE sessions
  ADD CONSTRAINT sessions_name_length_check
  CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80);

-- Rollback:
--   ALTER TABLE sessions DROP CONSTRAINT sessions_name_length_check;
--   ALTER TABLE sessions DROP CONSTRAINT sessions_kind_check;
--   ALTER TABLE sessions DROP COLUMN kind, DROP COLUMN name, DROP COLUMN user_agent;
