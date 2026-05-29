-- Up Migration

CREATE TABLE sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- Lookup by token hash is the hot path on every session validation after a restart.
CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);

-- Used by the prune sweep to delete expired rows efficiently.
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

-- Rollback: DROP TABLE sessions;
