-- 127_action_log_requester_unverified.sql
--
-- An approval raised on a turn that matched the principal's identity but whose channel did not
-- authenticate the sender (an SMS, or email failing SPF, DKIM or DMARC) is marked, so delivery
-- sends it only where the principal is proven (Signal, Slack, the phone app) and caps how many
-- go out in an hour (GHSA-p49r-jqh2-v668). Existing rows were raised before the distinction
-- and keep false.

-- Up Migration

ALTER TABLE autonomy_action_log
  ADD COLUMN requester_unverified BOOLEAN NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE autonomy_action_log DROP COLUMN requester_unverified;
