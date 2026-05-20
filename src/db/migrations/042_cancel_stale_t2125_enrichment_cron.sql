-- Cancel the stale T2125 enrichment cron row left behind by the dark-period change.
--
-- Background: upsertDeclarativeJob matches on (agent_id, cron_expr, task_payload::text).
-- When the enrichment cron changed from */30 * * * * to */30 6-17 * * *, the old row
-- was not updated — a new row was created. Without this migration the old all-day row
-- would keep firing alongside the new time-windowed one.
--
-- This migration is idempotent: if the old row was already cancelled or never existed
-- (e.g. on a fresh install), the UPDATE touches zero rows and succeeds.

UPDATE scheduled_jobs
   SET status = 'cancelled'
 WHERE agent_id = 'T2125-expense-tracker'
   AND cron_expr  = '*/30 * * * *'
   AND created_by = 'system'
   AND status IN ('pending', 'failed');
