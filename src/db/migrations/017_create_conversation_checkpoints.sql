-- Up Migration
-- Watermark table for the conversation checkpoint pipeline.
-- One row per (conversation_id, agent_id) pair — upserted after each checkpoint run.
-- The primary key enforces at-most-one watermark per pair; there is no delete path.

CREATE TABLE conversation_checkpoints (
  conversation_id    TEXT        NOT NULL,
  agent_id           TEXT        NOT NULL,
  last_checkpoint_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_id)
);

-- Down Migration
DROP TABLE IF EXISTS conversation_checkpoints;
