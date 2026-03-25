-- Up Migration

CREATE TABLE working_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ
);

-- Primary query pattern: load conversation history for a specific agent + conversation
-- in chronological order. The composite index covers the WHERE + ORDER BY.
CREATE INDEX idx_wm_conversation ON working_memory (conversation_id, agent_id, created_at);

-- Cleanup query: find and delete expired entries periodically
CREATE INDEX idx_wm_expires ON working_memory (expires_at) WHERE expires_at IS NOT NULL;
