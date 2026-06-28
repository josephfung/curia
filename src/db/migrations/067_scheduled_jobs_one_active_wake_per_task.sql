-- 067_scheduled_jobs_one_active_wake_per_task.sql
--
-- Enforce at most one pending or running wake per task_id. Resumable continuation
-- scheduling (#1175) and the BacklogHeartbeat both assume this invariant; the
-- partial unique index makes duplicate inserts fail atomically under concurrency.

-- Up Migration
CREATE UNIQUE INDEX scheduled_jobs_one_active_wake_per_task_uq
  ON scheduled_jobs (task_id)
  WHERE task_id IS NOT NULL AND status IN ('pending', 'running');

-- Down Migration
DROP INDEX IF EXISTS scheduled_jobs_one_active_wake_per_task_uq;
