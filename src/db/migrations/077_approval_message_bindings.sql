-- Up Migration

-- 077_approval_message_bindings.sql
--
-- Durable map from a delivered outbound provider message id (Slack ts, Signal
-- send timestamp, …) to a pending approval row. Used by the channel-agnostic
-- inbound.reaction → approval mapper (#1479). Correlation keys on
-- (channel, message_id) only — never conversationId (ADR-033).

CREATE TABLE approval_message_bindings (
  id            BIGSERIAL PRIMARY KEY,
  action_log_id BIGINT NOT NULL REFERENCES autonomy_action_log(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_approval_message_bindings_channel_message
    UNIQUE (channel, message_id)
);

CREATE INDEX idx_approval_message_bindings_action_log
  ON approval_message_bindings (action_log_id);

-- Down Migration

DROP TABLE IF EXISTS approval_message_bindings;
