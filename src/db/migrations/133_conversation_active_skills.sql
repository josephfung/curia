-- Up Migration
-- Conversation-scoped skill activation carry (#2764 / ADR-070).
-- Skills activated (or used) in a conversation stay until idle past the TTL,
-- at most CONVERSATION_ACTIVE_SKILLS_CAP, most recently used first.

CREATE TABLE conversation_active_skills (
  conversation_id TEXT        NOT NULL,
  agent_id        TEXT        NOT NULL,
  skill           TEXT        NOT NULL,
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_id, skill)
);

CREATE INDEX conversation_active_skills_mru_idx
  ON conversation_active_skills (conversation_id, agent_id, last_used_at DESC);

-- Down Migration
DROP TABLE IF EXISTS conversation_active_skills;
