-- 130_setup_state.sql
--
-- What the console's Setup page collects that has no other home (#2358). One row.
-- Kept out of the knowledge graph on purpose: the operator's name and email are
-- setup and admin records, not something Curia knows about the principal's world.
--
-- phase: NULL on an install that predates the Setup page (it is treated as done
-- once the office identity is configured), 'in_progress' from the first Setup
-- save on a new install, 'complete' once Start onboarding is pressed.

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

-- Down Migration

DROP TABLE IF EXISTS setup_state;
