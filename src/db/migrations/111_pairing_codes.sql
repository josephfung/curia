-- 111_pairing_codes.sql
--
-- Single-use phone pairing codes (#2341, ADR-055). The token and the short
-- code are stored hashed. Each can be redeemed once before expires_at, so a
-- typed code still works when the Safari cookie did not reach the home-screen
-- app. The plaintext never lands in this table.

-- Up Migration

CREATE TABLE pairing_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  short_code_hash TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  token_redeemed_at TIMESTAMPTZ,
  short_redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_codes_expires_at ON pairing_codes (expires_at);

-- Down Migration

DROP TABLE IF EXISTS pairing_codes;
