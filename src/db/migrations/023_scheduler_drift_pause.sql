-- 023_scheduler_drift_pause.sql
--
-- Adds a partial index for the 'paused' status on scheduled_jobs.
-- This supports efficient API queries for paused jobs and watchdog exclusion.
--
-- No constraint changes are needed:
--   - scheduled_jobs.status is TEXT with no CHECK constraint
--   - agent_tasks.status is TEXT with no CHECK constraint
--   - last_run_outcome is NOT set to 'paused' on the drift path (completeJobRun
--     is skipped, so last_run_outcome retains its prior value)

-- Up Migration
CREATE INDEX idx_scheduled_jobs_paused
  ON scheduled_jobs (id)
  WHERE status = 'paused';

-- Down Migration
DROP INDEX IF EXISTS idx_scheduled_jobs_paused;
