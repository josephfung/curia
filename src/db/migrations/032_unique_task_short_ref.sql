-- Up Migration

-- 032_unique_task_short_ref.sql
--
-- Adds a UNIQUE constraint on (task_id, short_ref) to prevent race conditions
-- in short_ref generation. Null short_ref values (non-approval rows) do not
-- violate the constraint — Postgres treats nulls as never equal.
--
-- See issue #428 and the #436 review discussion.

-- Pre-check: abort if legacy duplicates exist.
-- The table was introduced in PR #436 (1-2 days before this migration), so
-- duplicates are unlikely but this guard prevents a confusing ALTER TABLE failure.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM autonomy_action_log
    WHERE short_ref IS NOT NULL
    GROUP BY task_id, short_ref
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add UNIQUE constraint: duplicate (task_id, short_ref) rows exist. '
      'Run: SELECT task_id, short_ref, COUNT(*) FROM autonomy_action_log '
      'WHERE short_ref IS NOT NULL GROUP BY task_id, short_ref HAVING COUNT(*) > 1; '
      'to find and manually resolve duplicates before re-running this migration.';
  END IF;
END
$$;

ALTER TABLE autonomy_action_log
  ADD CONSTRAINT uq_aal_task_short_ref UNIQUE (task_id, short_ref);

-- Down Migration

ALTER TABLE autonomy_action_log
  DROP CONSTRAINT uq_aal_task_short_ref;
