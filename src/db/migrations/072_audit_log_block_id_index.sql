-- Up Migration
--
-- Index to support diagnostics lookups by blockId (#1356). An `outbound.blocked`
-- audit event stores its blockId in the JSONB payload (not a column), so
-- "what happened with block_<id>?" would otherwise be a sequential scan. Mirrors
-- the payload->>'taskId' index from migration 071.

CREATE INDEX idx_audit_log_payload_block_id
  ON audit_log ((payload->>'blockId'))
  WHERE payload->>'blockId' IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_audit_log_payload_block_id;
