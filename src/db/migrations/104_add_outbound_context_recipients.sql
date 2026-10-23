-- 104_add_outbound_context_recipients.sql
--
-- Who each outbound_context entry was sent to, and what they have written back since
-- (#2261, Fix B of #1848).
--
-- recipient_contact_ids: the dispatcher shows a non-principal sender only the entries sent
-- to them, so a third party's reply reaches the coordinator with the question it answers.
-- Rows written before this migration keep NULL and are never shown on a non-principal turn,
-- which is how they behaved before it.
--
-- recipient_messages: messages a recipient sent while the entry was active, stamped by the
-- dispatcher so a later principal turn or task wake can see them. A JSON array of
-- {at, from, contact_id, preview, risk_score}, holding the first three messages and the
-- latest three: an early one is most often the answer, and a later "can you resend the
-- address?" must not replace it. contact_id is the sender's, which a wake an outside contact
-- started filters on so it lists only their own messages; risk_score is the inbound's
-- injection-scan score.
-- last_recipient_message_at orders and filters entries for task wakes.

-- Up Migration

ALTER TABLE outbound_context
  ADD COLUMN recipient_contact_ids UUID[],
  ADD COLUMN recipient_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN last_recipient_message_at TIMESTAMPTZ;

CREATE INDEX idx_outbound_context_recipients
  ON outbound_context USING GIN (recipient_contact_ids)
  WHERE released = false;

-- Rollback:
--   DROP INDEX idx_outbound_context_recipients;
--   ALTER TABLE outbound_context DROP COLUMN recipient_contact_ids,
--     DROP COLUMN recipient_messages, DROP COLUMN last_recipient_message_at;
