-- Up Migration
--
-- Indexes to support Ant Farm timeline queries (AF-1):
--   - payload->>'taskId' for task-scoped replay (task_id column is often NULL)
--   - (conversation_id, timestamp) for conversation-scoped time windows

CREATE INDEX idx_audit_log_payload_task_id
  ON audit_log ((payload->>'taskId'))
  WHERE payload->>'taskId' IS NOT NULL;

CREATE INDEX idx_audit_log_conversation_timestamp
  ON audit_log (conversation_id, timestamp)
  WHERE conversation_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_audit_log_conversation_timestamp;
DROP INDEX IF EXISTS idx_audit_log_payload_task_id;
