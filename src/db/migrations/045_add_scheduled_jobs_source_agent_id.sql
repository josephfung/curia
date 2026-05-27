-- 045_add_scheduled_jobs_source_agent_id.sql
--
-- Include the declaring agent in declarative job identity. This lets two
-- specialist agents declare identical schedules targeting the same agent
-- without collapsing into one scheduled_jobs row.

ALTER TABLE scheduled_jobs
  ADD COLUMN source_agent_id TEXT NOT NULL DEFAULT '';

-- Existing declarative jobs were keyed only by target agent. Preserve that
-- legacy identity before switching to the source-aware unique index, otherwise
-- startup can insert a duplicate row beside an operator-paused legacy job.
UPDATE scheduled_jobs
   SET source_agent_id = agent_id
 WHERE created_by = 'system'
   AND source_agent_id = '';

DROP INDEX IF EXISTS scheduled_jobs_declarative_uq;

CREATE UNIQUE INDEX scheduled_jobs_declarative_uq
  ON scheduled_jobs (source_agent_id, agent_id, cron_expr, (task_payload::text))
  WHERE created_by = 'system';

-- Rollback:
-- DROP INDEX IF EXISTS scheduled_jobs_declarative_uq;
-- CREATE UNIQUE INDEX scheduled_jobs_declarative_uq
--   ON scheduled_jobs (agent_id, cron_expr, (task_payload::text))
--   WHERE created_by = 'system';
-- ALTER TABLE scheduled_jobs DROP COLUMN source_agent_id;
