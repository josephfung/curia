-- Up Migration

CREATE TABLE bullpen_threads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic             TEXT        NOT NULL,
  creator_agent_id  TEXT        NOT NULL,
  participants      TEXT[]      NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'open',
  message_count     INT         NOT NULL DEFAULT 0,       -- maintained atomically by BullpenService (CTE update + INSERT)
  last_message_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bullpen_messages (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           UUID        NOT NULL REFERENCES bullpen_threads(id) ON DELETE CASCADE,
  sender_type         TEXT        NOT NULL DEFAULT 'agent',
  sender_id           TEXT        NOT NULL,
  content             JSONB       NOT NULL,
  mentioned_agent_ids TEXT[]      NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast participant lookups for context injection
CREATE INDEX idx_bullpen_threads_participants ON bullpen_threads USING GIN (participants);
-- Fast message retrieval per thread
CREATE INDEX idx_bullpen_messages_thread_created ON bullpen_messages (thread_id, created_at);

-- Down Migration

DROP TABLE IF EXISTS bullpen_messages;
DROP TABLE IF EXISTS bullpen_threads;
