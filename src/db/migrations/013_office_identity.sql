-- Up Migration

-- Full version history of every office identity change.
-- Append-only — rows are never updated or deleted.
-- SERIAL/INTEGER (not BIGSERIAL/BIGINT) because node-postgres returns int8 columns as
-- JavaScript strings by default, breaking our TypeScript `id: number` contract.
-- Identity versions will never approach 2 billion rows in practice.
CREATE TABLE office_identity_versions (
  id          SERIAL PRIMARY KEY,
  version     INTEGER NOT NULL UNIQUE,     -- monotonically increasing per-change counter; UNIQUE enforces no duplicate versions
  config      JSONB NOT NULL,             -- full OfficeIdentity config snapshot at time of change
  changed_by  TEXT NOT NULL,              -- 'file_load' | 'wizard' | 'api'
  note        TEXT,                       -- optional human-readable reason for change
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row table pointing to the active version.
-- The singleton PRIMARY KEY constraint ensures only one row can ever exist.
-- The CHECK (singleton = TRUE) makes it impossible to insert a second row
-- with singleton = FALSE, closing the gap the PK alone would leave open.
CREATE TABLE office_identity_current (
  singleton   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  version_id  INTEGER NOT NULL REFERENCES office_identity_versions(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
