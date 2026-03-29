-- Up Migration

-- Scheduled jobs: the job registry for cron and one-shot tasks.
-- The scheduler loop polls for due jobs every 30s using FOR UPDATE SKIP LOCKED.
CREATE TABLE scheduled_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              TEXT NOT NULL,
  cron_expr             TEXT,
  run_at                TIMESTAMPTZ,
  task_payload          JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  last_run_at           TIMESTAMPTZ,
  next_run_at           TIMESTAMPTZ,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_by            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cron_or_run_at CHECK (cron_expr IS NOT NULL OR run_at IS NOT NULL)
);

-- Partial index: the scheduler loop only queries pending/failed jobs by next_run_at.
-- Completed, suspended, and cancelled rows are excluded from the index.
CREATE INDEX idx_scheduled_jobs_due
  ON scheduled_jobs (next_run_at)
  WHERE status IN ('pending', 'failed');

-- Unique constraint for declarative job upsert (prevents duplicates on restart).
-- task_payload is cast to text for equality comparison.
CREATE UNIQUE INDEX scheduled_jobs_declarative_uq
  ON scheduled_jobs (agent_id, cron_expr, (task_payload::text))
  WHERE created_by = 'system';

-- Agent tasks: persistent state for multi-burst agent work.
-- Each burst, the agent loads intent_anchor + progress, does work, updates progress.
CREATE TABLE agent_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          TEXT NOT NULL,
  intent_anchor     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  progress          JSONB NOT NULL DEFAULT '{}',
  error_budget      JSONB NOT NULL,
  conversation_id   UUID,
  scheduled_job_id  UUID REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_tasks_job ON agent_tasks (scheduled_job_id);
