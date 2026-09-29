-- 095_scheduled_jobs_deferred_wake_at.sql
--
-- A task that reschedules its own wake while that job is still `running` cannot
-- insert a second active row (migration 067) and must not mutate run_at on the
-- row the scheduler is finishing — completion would mark it completed and drop
-- the new time. Record the requested time here; completeJobRun / recoverStuckJob
-- arm it on the same row when the run ends (#1938).

-- Up Migration

ALTER TABLE scheduled_jobs
  ADD COLUMN deferred_wake_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE scheduled_jobs
  DROP COLUMN IF EXISTS deferred_wake_at;
