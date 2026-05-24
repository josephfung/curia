-- 043_widen_system_role_check.sql
--
-- Widen the CHECK constraint on contacts.system_role to include 'system',
-- matching the expanded SystemRole type (issue #558).
-- 'system' represents operator-configured, platform-executed entities
-- (e.g. declarative YAML-defined scheduled jobs).

-- Drop the old unnamed CHECK and re-add with the wider set.
-- Postgres does not support ALTER CONSTRAINT for CHECK constraints,
-- so we drop-and-recreate.
ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_system_role_check;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_system_role_check
  CHECK (system_role IN ('principal', 'agent', 'system'));
