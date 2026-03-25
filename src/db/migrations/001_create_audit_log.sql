-- Up
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

-- event_type and source_id are the most common filter axes (e.g., "show me all
-- agent.task events" or "show me all events from agent X").
CREATE INDEX idx_audit_event_type ON audit_log (event_type);
CREATE INDEX idx_audit_source_id ON audit_log (source_id);

-- Partial index: conversation_id is optional (NULL for system events), so we
-- only index rows where it is present to keep the index small.
CREATE INDEX idx_audit_conversation ON audit_log (conversation_id) WHERE conversation_id IS NOT NULL;

-- Time-range queries ("show me the last hour of events") need a timestamp index.
CREATE INDEX idx_audit_timestamp ON audit_log (timestamp);

-- Partial index on unacknowledged rows: the acknowledgement worker scans only
-- these, so filtering on acknowledged = false is the hot path.
CREATE INDEX idx_audit_unacknowledged ON audit_log (acknowledged) WHERE acknowledged = false;

-- Down
DROP TABLE IF EXISTS audit_log;
