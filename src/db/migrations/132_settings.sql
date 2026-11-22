-- 132_settings.sql
--
-- A home for instance-level admin settings (#2709, prerequisite for the operator design,
-- #2365): `settings` holds one typed JSONB value per key, and `settings_history` records
-- every write so "who changed X, and when" has an answer. Replaces setup_state (migration
-- 130), which mixed Setup progress with durable admin settings under a name that only
-- described the first.
--
-- Out of the knowledge graph on purpose: these are admin records, not something Curia
-- knows about the principal's world. No agent tool writes settings or imports the store;
-- two tools (setup-status, onboarding-progress) see a read-only Setup projection through
-- injected services. The typed registry in src/settings/ is the only reader and writer; a
-- missing row means the key's declared default applies.

-- Up Migration

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  -- ISO timestamps are stored as JSON strings; anything else is rejected on read by the
  -- registry, which logs the bad value at error level and treats the key as unset.
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'console', 'setup', or a migration marker. Free text: the actor is not a foreign key,
  -- because the person who saved a setting need not be a contact.
  updated_by TEXT NOT NULL
);

CREATE TABLE settings_history (
  id         BIGSERIAL PRIMARY KEY,
  key        TEXT NOT NULL,
  -- NULL when the key was absent (first write, or after a clear).
  old_value  JSONB,
  -- NULL when the write cleared the key.
  new_value  JSONB,
  updated_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Who changed X, and when": newest first for one key.
CREATE INDEX idx_settings_history_key_changed_at
  ON settings_history (key, changed_at DESC);

-- Append-only at the database level, like audit_log (migration 021). History that can be
-- rewritten answers nothing, so no UPDATE or DELETE is permitted on a row.
CREATE OR REPLACE FUNCTION settings_history_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'settings_history is append-only: % operations are not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settings_history_immutable_trigger
  BEFORE UPDATE OR DELETE ON settings_history
  FOR EACH ROW EXECUTE FUNCTION settings_history_immutable();

-- Take over what setup_state held.
--
-- operator: only when Setup was for someone else and both halves are present. A "myself"
-- install can carry stale operator fields (the old page allowed a half-save); copying them
-- would flip it to "someone else". The registry's schema is { name, email }, and a partial
-- pair was never usable, so a half-written pair is dropped rather than made to satisfy it.
INSERT INTO settings (key, value, updated_by)
SELECT 'operator',
       jsonb_build_object('name', btrim(operator_name), 'email', lower(btrim(operator_email))),
       'migration:132'
  FROM setup_state
 WHERE id = 1
   AND setup_for = 'other'
   AND btrim(coalesce(operator_name, '')) <> ''
   AND btrim(coalesce(operator_email, '')) <> '';

INSERT INTO settings (key, value, updated_by)
SELECT 'messaging_route', to_jsonb(messaging_route), 'migration:132'
  FROM setup_state
 WHERE id = 1 AND messaging_route IS NOT NULL;

INSERT INTO settings (key, value, updated_by)
SELECT 'voice_route', to_jsonb(voice_route), 'migration:132'
  FROM setup_state
 WHERE id = 1 AND voice_route IS NOT NULL;

-- The old phase becomes the completed_at marker. A phase='complete' row with a NULL
-- completed_at (an install that predates the Setup page, marked complete by migration
-- 130) gets one now: the new model has no phase column, and completed_at is what says
-- Setup is finished.
INSERT INTO settings (key, value, updated_by)
SELECT 'setup.completed_at',
       to_jsonb(to_char(COALESCE(completed_at, now()) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
       'migration:132'
  FROM setup_state
 WHERE id = 1 AND phase = 'complete';

DROP TABLE setup_state;

-- Down Migration

DROP TRIGGER IF EXISTS settings_history_immutable_trigger ON settings_history;
DROP FUNCTION IF EXISTS settings_history_immutable();

-- Recreate the single-row table 130 defined and copy the settings back. The phase is
-- derived the same way the registry derives it: completed_at set means complete.
CREATE TABLE setup_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  phase TEXT CHECK (phase IN ('in_progress', 'complete')),
  setup_for TEXT CHECK (setup_for IN ('self', 'other')),
  operator_name TEXT,
  operator_email TEXT,
  messaging_route TEXT CHECK (messaging_route IN ('app', 'signal', 'sms', 'slack')),
  voice_route TEXT CHECK (voice_route IN ('app', 'signal')),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO setup_state (
  id, phase, setup_for, operator_name, operator_email, messaging_route, voice_route, completed_at
)
SELECT 1,
       CASE WHEN (SELECT value FROM settings WHERE key = 'setup.completed_at') IS NOT NULL
            THEN 'complete' ELSE 'in_progress' END,
       CASE WHEN (SELECT value FROM settings WHERE key = 'operator') IS NOT NULL
            THEN 'other' ELSE 'self' END,
       (SELECT value->>'name' FROM settings WHERE key = 'operator'),
       (SELECT value->>'email' FROM settings WHERE key = 'operator'),
       (SELECT (value #>> '{}') FROM settings WHERE key = 'messaging_route')::text,
       (SELECT (value #>> '{}') FROM settings WHERE key = 'voice_route')::text,
       (SELECT (value #>> '{}')::timestamptz FROM settings WHERE key = 'setup.completed_at')
 WHERE EXISTS (SELECT 1 FROM settings);

DROP TABLE settings_history;
DROP TABLE settings;
