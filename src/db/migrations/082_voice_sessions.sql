CREATE TABLE voice_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL UNIQUE,
  livekit_room  TEXT NOT NULL,
  principal_contact_id UUID NULL REFERENCES contacts(id),
  status        TEXT NOT NULL CHECK (status IN ('starting','active','ended','failed')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  end_reason    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX voice_sessions_status_idx ON voice_sessions (status);
