-- 112_web_push.sql
--
-- Phone-app push subscriptions (#2341, ADR-055). A subscription belongs to one
-- console session and disappears with it. The VAPID key pair lives in the
-- vault, not here. hide_previews replaces the notification body with a fixed
-- line. Notices are what the console shows when a phone stops receiving pushes
-- or the push service rejects the setup.

-- Up Migration

CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_subscriptions_session ON push_subscriptions (session_id);

CREATE TABLE push_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hide_previews BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO push_settings (id, hide_previews) VALUES (1, false);

CREATE TABLE push_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('dead', 'setup')),
  detail TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at TIMESTAMPTZ
);

-- Down Migration

DROP TABLE IF EXISTS push_notices;
DROP TABLE IF EXISTS push_settings;
DROP TABLE IF EXISTS push_subscriptions;
