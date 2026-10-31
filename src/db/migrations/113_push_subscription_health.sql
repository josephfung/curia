-- 113_push_subscription_health.sql
--
-- How a push subscription is doing (#2341). A run of failures marks it dead.
-- Success clears the run. The columns are nullable timestamps plus a counter
-- so a subscription that has never been pushed stays at zero.

-- Up Migration

ALTER TABLE push_subscriptions
  ADD COLUMN last_success_at TIMESTAMPTZ,
  ADD COLUMN last_failure_at TIMESTAMPTZ,
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE push_subscriptions
  DROP COLUMN IF EXISTS consecutive_failures,
  DROP COLUMN IF EXISTS last_failure_at,
  DROP COLUMN IF EXISTS last_success_at;
