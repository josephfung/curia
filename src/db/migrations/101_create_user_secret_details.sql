-- 101_create_user_secret_details.sql
--
-- Non-secret sign-in details for a personal (user.*) vault secret: where to sign in and
-- with which username (#2201). Kept apart from `secrets`, which holds only ciphertext, so
-- list-user-secrets can return these next to the key names without touching a value.
-- Written when a capture link is minted (before the secret row exists), so there is no
-- foreign key; a row whose secret is gone is simply never listed.

-- Up Migration

CREATE TABLE user_secret_details (
  name       TEXT PRIMARY KEY CHECK (starts_with(name, 'user.')),
  login_url  TEXT,
  username   TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS user_secret_details;
