CREATE TABLE voice_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL UNIQUE,
  livekit_room  TEXT NOT NULL,
  -- Nullable + ON DELETE SET NULL: a voice session record outlives the contact
  -- it references. Without an explicit action Postgres defaults to NO ACTION,
  -- which would make any future contact delete/merge (contact.merged events)
  -- fail on a referenced row. The session's own identity is `id`, not the FK.
  principal_contact_id UUID NULL REFERENCES contacts(id) ON DELETE SET NULL,
  status        TEXT NOT NULL CHECK (status IN ('starting','active','ended','failed')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  end_reason    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX voice_sessions_status_idx ON voice_sessions (status);
