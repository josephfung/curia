-- Up Migration

CREATE TABLE sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- The UNIQUE constraint on token_hash already creates a btree index for the hot lookup path.
-- This separate index covers only the prune sweep (DELETE WHERE expires_at < NOW()).
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

-- Rollback: DROP TABLE sessions;
