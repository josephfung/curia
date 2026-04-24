-- Up Migration
--
-- Partial composite index to support hasOutboundToRecipientInConversation in
-- Dispatcher (Fix B of the outbound trust fix, PR #337).
--
-- The query is:
--   SELECT EXISTS (
--     SELECT 1 FROM audit_log
--     WHERE event_type = 'outbound.message'
--       AND conversation_id = $1
--       AND payload->>'recipientId' = $2
--   )
--
-- Without this index, Postgres must scan all rows with the given conversation_id
-- (via idx_audit_conversation) and then filter on payload->>'recipientId' — a
-- per-row JSONB extraction for every outbound message in the conversation.
-- As audit_log grows this check runs on every provisional/unknown inbound
-- before the hold decision, so latency degrades linearly with table size.
--
-- The partial index (WHERE event_type = 'outbound.message') keeps the index
-- small — only outbound messages are indexed — and turns the EXISTS check into
-- an index lookup on (conversation_id, recipientId) rather than a seq/bitmap scan.

CREATE INDEX idx_audit_log_thread_trust
  ON audit_log (conversation_id, (payload->>'recipientId'))
  WHERE event_type = 'outbound.message';

-- Down Migration

DROP INDEX IF EXISTS idx_audit_log_thread_trust;
