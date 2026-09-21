-- Up Migration: conversation-scoped resolved contact IDs (#1818)
--
-- working_memory keeps the user text and the final assistant text. Tool
-- results, including a contacts briefing's <resolved_entities> block, are
-- discarded at the end of the turn. This table remembers which contacts were
-- resolved in a conversation so the next turn can re-read the contact row
-- (current name, email, phone) instead of replaying the old briefing.
--
-- Rows stay for the life of the conversation (deleting the contact cascades).
-- There is no TTL sweep; reads are bounded by MAX_RESOLVED_ENTITIES.

CREATE TABLE conversation_resolved_entities (
  conversation_id TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  resolved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_id, contact_id)
);

CREATE INDEX idx_conversation_resolved_entities_recent
  ON conversation_resolved_entities (conversation_id, agent_id, resolved_at DESC);

-- Rollback: DROP TABLE conversation_resolved_entities;
