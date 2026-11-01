-- 111_pairing_codes.sql
--
-- Single-use phone pairing codes (#2341, ADR-055). The token and the short
-- code are stored hashed. Each can be redeemed once before expires_at.
-- Once a session is recorded, the row's remaining life is capped at two
-- minutes, whichever credential was redeemed. That cap is a later UPDATE:
-- releasing a credential after a failed sign-in must leave the original
-- window. The plaintext never lands in this table. Each credential stores
-- its own device label for the desktop status poll.

-- Up Migration

CREATE TABLE pairing_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  short_code_hash TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  token_redeemed_at TIMESTAMPTZ,
  short_redeemed_at TIMESTAMPTZ,
  token_device_name TEXT,
  short_device_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_codes_expires_at ON pairing_codes (expires_at);

-- Down Migration

DROP TABLE IF EXISTS pairing_codes;
