-- 019_scheduler_prior_run_context.sql
--
-- Adds three columns to support structured prior-run context for scheduled jobs.
-- last_run_outcome: written by the scheduler on completion/timeout (queryable).
-- last_run_summary: agent-written human-readable summary of what the job did.
-- last_run_context: agent-written opaque JSONB for job-specific continuity state.
--
-- All three default to NULL — no backfill needed. The no-history-replay fix
-- (unique per-run conversationId) is a code-only change; no schema change required.

ALTER TABLE scheduled_jobs
  ADD COLUMN last_run_outcome TEXT
    CHECK (last_run_outcome IN ('completed', 'failed', 'timed_out')),
  ADD COLUMN last_run_summary TEXT,
  ADD COLUMN last_run_context JSONB;
