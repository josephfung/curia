-- Up Migration
--
-- Issue #952: grant_recommendations table.
--
-- Stores proactive grant suggestions that Curia surfaces to the CEO.
-- The table acts as both the recommendation queue and the permanent
-- anti-nag ledger: a declined row is never deleted, so the judge can
-- check UNIQUE(contact_id, permission) and never re-suggest the same
-- capability for the same contact.
--
-- status flow:
--   pending   → approved  (CEO approves; contact_auth_overrides row also written)
--   pending   → declined  (CEO declines; permanent — never resurfaces)
--
-- Only one row per (contact_id, permission) pair is ever created.
-- The judge must check for an existing row before inserting.

CREATE TABLE grant_recommendations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  permission      TEXT NOT NULL,
  reasoning       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'declined')),
  suggested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,

  -- Pending rows must have no resolver metadata; resolved rows must have both.
  CHECK (
    (status = 'pending'  AND resolved_at IS NULL AND resolved_by IS NULL) OR
    (status != 'pending' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  ),

  -- One lifetime record per contact+permission pair prevents re-nag.
  UNIQUE (contact_id, permission)
);

CREATE INDEX idx_gr_pending    ON grant_recommendations (suggested_at)
  WHERE status = 'pending';
CREATE INDEX idx_gr_contact    ON grant_recommendations (contact_id);

-- Down Migration
DROP INDEX IF EXISTS idx_gr_contact;
DROP INDEX IF EXISTS idx_gr_pending;
DROP TABLE IF EXISTS grant_recommendations;
