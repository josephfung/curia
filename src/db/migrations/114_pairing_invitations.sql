-- 114_pairing_invitations.sql
--
-- Phone app invitation links (#2412, ADR-055 amendment of 2026-11-02). The operator mints one for
-- the principal and sends it through their own channel. It lasts 48 hours and
-- works once. Every console session already belongs to the principal, so the
-- binding needs no column. The token is stored hashed.
--
-- At most one invitation is current: minting a new one sets superseded_at on
-- the old row, and the partial unique index refuses a second current row when
-- two mints race. The console shows the current row as waiting, redeemed or
-- expired. Rows that are not current are kept briefly for the audit trail and
-- pruned on the next mint.
--
-- push_notices gains a 'paired' kind, so every signed-in device hears that an
-- invitation was used. subject_session_id hides that notice from the phone it
-- describes.

-- Up Migration

CREATE TABLE pairing_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  device_name TEXT,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_pairing_invitations_one_current
  ON pairing_invitations ((true))
  WHERE superseded_at IS NULL;

ALTER TABLE push_notices DROP CONSTRAINT push_notices_kind_check;
ALTER TABLE push_notices
  ADD CONSTRAINT push_notices_kind_check CHECK (kind IN ('dead', 'setup', 'paired'));
ALTER TABLE push_notices ADD COLUMN subject_session_id UUID;

-- Down Migration

DELETE FROM push_notices WHERE kind = 'paired';
ALTER TABLE push_notices DROP COLUMN IF EXISTS subject_session_id;
ALTER TABLE push_notices DROP CONSTRAINT push_notices_kind_check;
ALTER TABLE push_notices
  ADD CONSTRAINT push_notices_kind_check CHECK (kind IN ('dead', 'setup'));
DROP TABLE IF EXISTS pairing_invitations;
