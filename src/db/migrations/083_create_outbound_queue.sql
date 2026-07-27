-- Up Migration: durable outbound queue for disconnected channels (#1380)

CREATE TABLE outbound_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  payload       JSONB NOT NULL,
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_outbound_queue_channel_enqueued
  ON outbound_queue (channel, enqueued_at);

CREATE INDEX idx_outbound_queue_expires
  ON outbound_queue (expires_at);

-- Rollback: DROP TABLE outbound_queue;
