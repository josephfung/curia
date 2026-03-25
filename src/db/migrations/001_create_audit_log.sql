-- Up Migration

CREATE TABLE audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type        TEXT NOT NULL,
  source_layer      TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  payload           JSONB NOT NULL,
  conversation_id   UUID,
  task_id           UUID,
  parent_event_id   UUID,
  acknowledged      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_audit_event_type ON audit_log (event_type);
CREATE INDEX idx_audit_source_id ON audit_log (source_id);
CREATE INDEX idx_audit_conversation ON audit_log (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_audit_timestamp ON audit_log (timestamp);
CREATE INDEX idx_audit_unacknowledged ON audit_log (acknowledged) WHERE acknowledged = false;
