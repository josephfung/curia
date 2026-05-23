-- Up Migration

CREATE TABLE outbound_context (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  content_preview  TEXT NOT NULL,
  expected_reply   TEXT,
  delegation_hint  TEXT,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  released         BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_outbound_context_active
  ON outbound_context (expires_at) WHERE released = false;

-- Rollback: DROP TABLE outbound_context;
