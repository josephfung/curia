-- Up Migration

-- Full version history of every executive profile change.
-- Append-only — rows are never updated or deleted.
-- Mirrors the office_identity_versions pattern exactly.
-- SERIAL/INTEGER (not BIGSERIAL/BIGINT) because node-postgres returns int8 columns as
-- JavaScript strings by default, breaking our TypeScript `id: number` contract.
CREATE TABLE executive_profile_versions (
  id          SERIAL PRIMARY KEY,
  version     INTEGER NOT NULL UNIQUE,     -- monotonically increasing per-change counter
  config      JSONB NOT NULL,             -- full ExecutiveProfile config snapshot at time of change
  changed_by  TEXT NOT NULL,              -- 'file_load' | 'wizard' | 'api'
  note        TEXT,                       -- optional human-readable reason for change
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row table pointing to the active version.
-- The singleton PRIMARY KEY constraint ensures only one row can ever exist.
CREATE TABLE executive_profile_current (
  singleton   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  version_id  INTEGER NOT NULL REFERENCES executive_profile_versions(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
