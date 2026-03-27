-- Up Migration

-- Held messages: stores inbound messages from unknown senders pending CEO review.
-- Messages stay here until the CEO identifies the sender (processed),
-- dismisses them (discarded), or they are auto-discarded by rate limiting.
CREATE TABLE held_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             TEXT NOT NULL,
  sender_id           TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  content             TEXT NOT NULL,
  subject             TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'pending',
  resolved_contact_id UUID REFERENCES contacts(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ
);

CREATE INDEX idx_held_messages_status ON held_messages (status, created_at)
  WHERE status = 'pending';

CREATE INDEX idx_held_messages_channel_status ON held_messages (channel, status)
  WHERE status = 'pending';
