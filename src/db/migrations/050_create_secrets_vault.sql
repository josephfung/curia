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

-- Trigger to auto-maintain updated_at on any UPDATE, regardless of whether the
-- caller explicitly sets it (e.g. the key rotation script, admin queries).
CREATE OR REPLACE FUNCTION secrets_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
$$;

CREATE TRIGGER secrets_updated_at
  BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION secrets_set_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS secrets_updated_at ON secrets;
DROP FUNCTION IF EXISTS secrets_set_updated_at();
DROP TABLE IF EXISTS secrets;
