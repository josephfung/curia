-- 123_principal_mailboxes.sql
--
-- Registry of the principal's Gmail mailboxes (#2475). One row per mailbox the principal has
-- connected through Nylas. The id is a short stable slug, immutable and never reused: a removed
-- mailbox keeps its row (removed_at set) so the id stays taken and old references still resolve
-- to a clear "removed" error instead of a fallback. The Nylas grant lives in the vault at
-- principal.mailbox.<id>.nylas_grant_id, not here.
--
-- At most one live mailbox is the default (partial unique index on a constant, the same shape as
-- idx_pairing_invitations_one_current). A removed default row may sit beside a live one. A live
-- address belongs to one mailbox; a removed row releases its address.
--
-- added_identity_id points at the contact_channel_identities row this registry added for the
-- address, so removal can retire it. SET NULL keeps the registry row if the identity is deleted.

-- Up Migration

CREATE TABLE principal_mailboxes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  is_default BOOLEAN NOT NULL DEFAULT false,
  triage_start_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  added_identity_id UUID REFERENCES contact_channel_identities(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT principal_mailboxes_id_check
    CHECK (id ~ '^[a-z][a-z0-9-]{0,31}$' AND id NOT IN ('primary', 'default')),
  CONSTRAINT principal_mailboxes_address_lower_check CHECK (address = lower(address))
);

CREATE UNIQUE INDEX idx_principal_mailboxes_one_default
  ON principal_mailboxes ((true))
  WHERE is_default AND removed_at IS NULL;

CREATE UNIQUE INDEX idx_principal_mailboxes_live_address
  ON principal_mailboxes (address)
  WHERE removed_at IS NULL;

-- Down Migration

DROP TABLE IF EXISTS principal_mailboxes;
