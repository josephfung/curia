-- Up Migration
-- Add run_started_at so the scheduler can detect jobs stuck in 'running' state.
-- Set when status transitions to 'running'; cleared on completeJobRun().
-- NULL for existing jobs (treated as "stuck since forever" by recoverStuckJobs()).
--
-- Add expected_duration_seconds for per-job timeout thresholds.
-- NULL falls back to the DEFAULT_EXPECTED_DURATION_SECONDS constant (600s / 10min).
-- Set from YAML for declarative jobs, or explicitly at job creation via skill/API.

ALTER TABLE scheduled_jobs
  ADD COLUMN run_started_at          TIMESTAMPTZ,
  ADD COLUMN expected_duration_seconds INTEGER;

-- Down Migration
-- ALTER TABLE scheduled_jobs
--   DROP COLUMN run_started_at,
--   DROP COLUMN expected_duration_seconds;
