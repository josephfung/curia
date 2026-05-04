-- Up Migration

-- 032_unique_task_short_ref.sql
--
-- Adds a UNIQUE constraint on (task_id, short_ref) to prevent race conditions
-- in short_ref generation. Null short_ref values (non-approval rows) do not
-- violate the constraint — Postgres treats nulls as never equal.
--
-- See issue #428 and the #436 review discussion.

ALTER TABLE autonomy_action_log
  ADD CONSTRAINT uq_aal_task_short_ref UNIQUE (task_id, short_ref);

-- Down Migration

ALTER TABLE autonomy_action_log
  DROP CONSTRAINT uq_aal_task_short_ref;
