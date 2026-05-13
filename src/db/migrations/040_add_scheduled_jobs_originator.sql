-- 040_add_scheduled_jobs_originator.sql
--
-- Add originator to scheduled_jobs so TaskOriginator is preserved across the
-- gap between when a schedule entry is created and when the job fires.
--
-- NULL for declarative (YAML-defined, system-created) jobs and for any jobs
-- created before this migration. isPrincipalOriginated() returns false for
-- null originators, preserving the existing conservative-default behaviour.
--
-- See: github.com/josephfung/curia/issues/504

ALTER TABLE scheduled_jobs ADD COLUMN originator JSONB;

-- Rollback: ALTER TABLE scheduled_jobs DROP COLUMN originator;
