-- 099_create_verifications.sql
--
-- A pending external verification: a third party (a site, later a bank) wants
-- proof from the principal before Curia can continue a delegated sign-in. One
-- live (pending) row per site, enforced by a partial unique index, so a second
-- turn reuses the pending challenge instead of triggering a new code. The code
-- value itself is never stored here (#2017).

-- Up Migration

CREATE TABLE verifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose            TEXT NOT NULL CHECK (purpose IN ('sign_in')),
  kind               TEXT NOT NULL CHECK (kind IN ('code')),
  delivery           TEXT NOT NULL CHECK (delivery IN ('email', 'sms', 'app')),
  -- Registrable domain of the site the principal asked about; the uniqueness key.
  site               TEXT NOT NULL,
  -- Registrable domain of the page showing the challenge (often an identity provider).
  page_domain        TEXT NOT NULL,
  browser_session_id TEXT NOT NULL,
  task_id            UUID,
  conversation_id    TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'satisfied', 'expired', 'abandoned')),
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  resolved_at        TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX verifications_one_pending_per_site
  ON verifications (site) WHERE status = 'pending';

CREATE INDEX verifications_status_resolved_at_idx
  ON verifications (status, resolved_at);

CREATE INDEX verifications_task_id_idx
  ON verifications (task_id) WHERE task_id IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS verifications;
