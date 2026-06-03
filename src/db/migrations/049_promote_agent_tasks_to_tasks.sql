-- Up Migration

-- Rename agent_tasks → tasks. The existing index on scheduled_job_id is dropped
-- automatically when we drop that column in a later step.
ALTER TABLE agent_tasks RENAME TO tasks;

-- Add the forward FK on scheduled_jobs BEFORE dropping the back-FK on tasks,
-- so we can backfill task_id from the existing scheduled_job_id values.
ALTER TABLE scheduled_jobs
  ADD COLUMN task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

-- Preflight: the old schema used a non-unique index on scheduled_job_id, so
-- application logic (not the DB) enforced one-task-per-job. If duplicates exist
-- the UPDATE...FROM below would pick one arbitrarily and silently drop the
-- other links. Fail loudly instead so the operator can investigate before data
-- is permanently lost.
DO $$
DECLARE dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT scheduled_job_id
    FROM tasks
    WHERE scheduled_job_id IS NOT NULL
    GROUP BY scheduled_job_id
    HAVING COUNT(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 049 preflight: % scheduled_job_id value(s) are referenced by more than one '
      'tasks row. Resolve duplicates before re-running this migration.',
      dup_count;
  END IF;
END $$;

-- Backfill scheduled_jobs.task_id from the existing tasks.scheduled_job_id.
-- Every tasks row that linked to a scheduled_job gets the forward FK populated.
UPDATE scheduled_jobs sj
  SET task_id = t.id
  FROM tasks t
  WHERE t.scheduled_job_id = sj.id;

-- Drop the old back-FK column (Postgres automatically drops the idx_agent_tasks_job index).
ALTER TABLE tasks DROP COLUMN scheduled_job_id;

-- Expand the status column: add CHECK with both legacy scheduler values and the
-- new task-lifecycle values. Legacy values remain valid until task skills ship in
-- issue 2, so existing scheduler code continues to work unchanged.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_ck
    CHECK (status IN (
      -- Legacy values used by the scheduler before task skills shipped
      'active', 'pending', 'paused', 'completed', 'failed',
      -- Task-lifecycle values introduced by this migration
      'open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled'
    ));

-- Add CEO-visible and task-management columns.
--
-- title: NOT NULL with empty-string DEFAULT so existing scheduler INSERT paths
--   continue to work without modification; backfilled from intent_anchor below.
-- owner, source, priority, created_by, tags: safe defaults that correctly
--   describe existing scheduler-created tasks.
-- Nullable columns (description, waiting_on_contact_id, waiting_on_text,
-- parent_task_id, blocked_by_task_id, due_at, source_agent_id): no backfill needed.
ALTER TABLE tasks
  ADD COLUMN title                 TEXT         NOT NULL DEFAULT '',
  ADD COLUMN description           TEXT,
  ADD COLUMN owner                 TEXT         NOT NULL DEFAULT 'curia'
    CHECK (owner IN ('curia', 'ceo', 'external')),
  ADD COLUMN waiting_on_contact_id UUID         REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN waiting_on_text       TEXT,
  ADD COLUMN parent_task_id        UUID         REFERENCES tasks(id),
  ADD COLUMN blocked_by_task_id    UUID         REFERENCES tasks(id),
  ADD COLUMN priority              INTEGER      NOT NULL DEFAULT 50,
  ADD COLUMN due_at                TIMESTAMPTZ,
  ADD COLUMN source                TEXT         NOT NULL DEFAULT 'agent'
    CHECK (source IN ('ceo', 'agent', 'scheduler', 'coordinator')),
  ADD COLUMN source_agent_id       TEXT,
  ADD COLUMN created_by            TEXT         NOT NULL DEFAULT 'system',
  ADD COLUMN tags                  TEXT[]       NOT NULL DEFAULT '{}';

-- Backfill existing rows:
--   title:          truncated intent_anchor (the durable goal statement is the
--                   best available title until the task-create skill ships)
--   source_agent_id: from agent_id (the agent that originally created the task)
--   owner and source are already correct from the defaults above
UPDATE tasks
  SET title          = LEFT(intent_anchor, 255),
      source_agent_id = agent_id
  WHERE title = '';

-- Indexes for common task-management query patterns:
--   tasks_open_priority_idx: backlog sweep and digest queries (open/in_progress by priority)
--   tasks_parent_idx:        subtask queries via parent_task_id
--   scheduled_jobs_task_idx: wake-up routing (issue 4) — find the schedule linked to a task
CREATE INDEX tasks_open_priority_idx ON tasks (priority DESC, due_at NULLS LAST)
  WHERE status IN ('open', 'in_progress');

CREATE INDEX tasks_parent_idx ON tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;

CREATE INDEX scheduled_jobs_task_idx ON scheduled_jobs (task_id)
  WHERE task_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS scheduled_jobs_task_idx;
DROP INDEX IF EXISTS tasks_parent_idx;
DROP INDEX IF EXISTS tasks_open_priority_idx;

-- Remove columns added in this migration.
ALTER TABLE tasks
  DROP COLUMN IF EXISTS tags,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS source_agent_id,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS due_at,
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS blocked_by_task_id,
  DROP COLUMN IF EXISTS parent_task_id,
  DROP COLUMN IF EXISTS waiting_on_text,
  DROP COLUMN IF EXISTS waiting_on_contact_id,
  DROP COLUMN IF EXISTS owner,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS title;

-- Remove the status CHECK added in this migration.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_ck;

-- Re-add the back-FK column on tasks (restoring the original FK direction).
ALTER TABLE tasks
  ADD COLUMN scheduled_job_id UUID REFERENCES scheduled_jobs(id) ON DELETE SET NULL;

-- Backfill tasks.scheduled_job_id from scheduled_jobs.task_id (reverse of up-migration step).
UPDATE tasks t
  SET scheduled_job_id = sj.id
  FROM scheduled_jobs sj
  WHERE sj.task_id = t.id;

-- Drop the forward FK column on scheduled_jobs.
ALTER TABLE scheduled_jobs DROP COLUMN IF EXISTS task_id;

-- Restore the original index on the back-FK column.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_job ON tasks (scheduled_job_id);

-- Rename tasks back to agent_tasks.
ALTER TABLE tasks RENAME TO agent_tasks;
