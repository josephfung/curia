-- Up Migration
-- One-time, single-use, time-boxed tokens that back agent-initiated secret capture (#971).
-- Holds NO secret material — only token metadata. The raw URL token exists only in the
-- magic link; we persist its SHA-256 hash (token_hash) so a DB read can never reconstruct
-- the capability. The secret VALUE never lands here at all — on redemption it is written
-- straight into the encrypted `secrets` vault and the token row is simply marked consumed.

CREATE TABLE secret_capture_tokens (
  token_hash   TEXT PRIMARY KEY,          -- SHA-256 of the raw URL token (raw token only ever in the URL)
  secret_name  TEXT NOT NULL,             -- resolved vault key, fixed & validated at mint time
  label        TEXT,                      -- human-friendly text shown on the form
  value_format TEXT NOT NULL DEFAULT 'string' CHECK (value_format IN ('string', 'json')),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,               -- set on first successful submission (single-use)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the periodic prune of expired tokens (same pattern as sessions).
CREATE INDEX idx_sct_expires ON secret_capture_tokens (expires_at);

-- Down Migration

DROP TABLE IF EXISTS secret_capture_tokens;
