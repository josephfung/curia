-- Up Migration
-- Add per-job timezone to scheduled_jobs.
-- Existing rows default to 'UTC' (preserves current behaviour — the scheduler
-- was always running in UTC, so existing job schedules were already UTC-relative).
--
-- The scheduler service reads this column when computing next_run_at via
-- nextRunFromCron() so that a job created with timezone='America/Toronto'
-- fires at the correct wall-clock time regardless of the server's TZ env var.
--
-- The scheduler-create skill exposes an optional 'timezone' input so users
-- can override the system default on a per-job basis.

ALTER TABLE scheduled_jobs
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

-- Down Migration
-- ALTER TABLE scheduled_jobs DROP COLUMN timezone;
