-- 130_setup_state.sql
--
-- What the console's Setup page collects that has no other home (#2358). One row.
-- Kept out of the knowledge graph on purpose: the operator's name and email are
-- setup and admin records, not something Curia knows about the principal's world.
--
-- phase: 'in_progress' on a new install until Start onboarding, then 'complete'.
-- No row means a new install that has saved nothing yet: also in Setup.

-- Up Migration

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

-- An install that predates the Setup page is never put through it. Decided once,
-- here: one with a saved office identity or a principal is already set up. A new
-- install has neither when its migrations run.
INSERT INTO setup_state (id, phase)
SELECT 1, 'complete'
WHERE EXISTS (SELECT 1 FROM office_identity_versions WHERE changed_by IN ('wizard', 'api'))
   OR EXISTS (SELECT 1 FROM contacts WHERE system_role = 'principal');

-- Down Migration

DROP TABLE IF EXISTS setup_state;
