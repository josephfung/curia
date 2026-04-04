-- Up Migration

-- Single-row table holding the live autonomy score.
-- The CONSTRAINT single_row CHECK (id = 1) ensures exactly one row exists —
-- enforced at the DB level rather than application code.
CREATE TABLE autonomy_config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  score       INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band        TEXT NOT NULL CHECK (band IN ('full', 'spot-check', 'approval-required', 'draft-only', 'restricted')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL,
  CONSTRAINT single_row CHECK (id = 1)
);

-- Append-only audit trail — never updated or deleted.
-- Phase 2 auto-adjustment will also write here (changed_by = 'system').
CREATE TABLE autonomy_history (
  id             BIGSERIAL PRIMARY KEY,
  score          INTEGER NOT NULL,
  previous_score INTEGER,
  band           TEXT NOT NULL CHECK (band IN ('full', 'spot-check', 'approval-required', 'draft-only', 'restricted')),
  changed_by     TEXT NOT NULL,
  reason         TEXT,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the default starting score (75 = approval-required).
-- ON CONFLICT DO NOTHING makes this idempotent on existing deployments.
INSERT INTO autonomy_config (id, score, band, updated_by)
VALUES (1, 75, 'approval-required', 'system')
ON CONFLICT (id) DO NOTHING;

-- Seed the corresponding history entry so the audit trail starts complete.
INSERT INTO autonomy_history (score, previous_score, band, changed_by, reason)
VALUES (75, NULL, 'approval-required', 'system', 'Initial default score');
