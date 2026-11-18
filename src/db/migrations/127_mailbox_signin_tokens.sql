-- 127_mailbox_signin_tokens.sql
--
-- Single-use links for signing in to a mailbox through Nylas hosted auth (#2361). The raw token
-- is the capability and lives only in the link and the OAuth `state`; this table keeps its
-- sha256 hash, never the token. The row carries what the callback needs and nothing secret:
-- which mailbox the link is for (target), the address the sign-in must land on (expected_email,
-- null for any account), an optional label, and the routing the originating agent resumes with.
-- Same shape as secret_capture_tokens.

-- Up Migration

CREATE TABLE mailbox_signin_tokens (
  token_hash TEXT PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('principal', 'curia')),
  expected_email TEXT,
  mailbox_label TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  conversation_id TEXT,
  channel_id TEXT,
  agent_id TEXT,
  task_event_id TEXT,
  originator JSONB,
  resume_token TEXT
);

-- Down Migration

DROP TABLE IF EXISTS mailbox_signin_tokens;
