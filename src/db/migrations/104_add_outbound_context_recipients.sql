-- 104_add_outbound_context_recipients.sql
--
-- Who each outbound_context entry was sent to, and the latest message back from them
-- (#2261, Fix B of #1848).
--
-- recipient_contact_ids: the dispatcher shows a non-principal sender only the entries sent
-- to them, so a third party's reply reaches the coordinator with the question it answers.
-- Rows written before this migration keep NULL and are never shown on a non-principal turn,
-- which is how they behaved before it.
--
-- last_reply_*: stamped by the dispatcher when a recipient writes in while the entry is
-- active, so a later principal turn or task wake can see that they answered.

-- Up Migration

ALTER TABLE outbound_context
  ADD COLUMN recipient_contact_ids UUID[],
  ADD COLUMN last_reply_at TIMESTAMPTZ,
  ADD COLUMN last_reply_from TEXT,
  ADD COLUMN last_reply_preview TEXT;

CREATE INDEX idx_outbound_context_recipients
  ON outbound_context USING GIN (recipient_contact_ids)
  WHERE released = false;

-- Rollback:
--   DROP INDEX idx_outbound_context_recipients;
--   ALTER TABLE outbound_context DROP COLUMN recipient_contact_ids, DROP COLUMN last_reply_at,
--     DROP COLUMN last_reply_from, DROP COLUMN last_reply_preview;
