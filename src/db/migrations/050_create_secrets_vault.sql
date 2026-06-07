-- Up Migration
-- Encrypted secrets vault (spec: docs/wip/2026-06-07-secrets-vault-design.md, #542).
-- Values are AES-256-GCM ciphertext written by the application layer; the DB never
-- sees plaintext. `value_format` is structural (how to decode), not semantic — an
-- OAuth token set or a browser session is simply a 'json' value owned by its consumer.

CREATE TABLE secrets (
  name            TEXT PRIMARY KEY,
  value_format    TEXT NOT NULL CHECK (value_format IN ('string', 'json')),
  encrypted_value TEXT NOT NULL,  -- base64( AES-256-GCM ciphertext || 16-byte auth tag )
  iv              TEXT NOT NULL,  -- base64, fresh 12 bytes per write
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE secrets;
