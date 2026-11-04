-- 116_derived_channel_identities.sql
--
-- Derived phone-family identities (#2447, ADR-047). A contact's verified number on
-- one of phone / sms / signal can be used on another; the row written for the new
-- channel has source 'derived' and records the row it was copied from here.
--
-- `source` is unconstrained TEXT, so the new value needs no CHECK change. The link
-- is nulled, not cascaded, when the source row is deleted: the derived row is still
-- a verified fact about the contact, and its source value keeps it auditable.

-- Up Migration

ALTER TABLE contact_channel_identities
  ADD COLUMN derived_from_identity_id UUID
    REFERENCES contact_channel_identities (id) ON DELETE SET NULL;

-- Only a derived row names a source row.
ALTER TABLE contact_channel_identities
  ADD CONSTRAINT contact_channel_identities_derived_from_check
    CHECK (derived_from_identity_id IS NULL OR source = 'derived');

-- Down Migration

ALTER TABLE contact_channel_identities
  DROP CONSTRAINT IF EXISTS contact_channel_identities_derived_from_check;
ALTER TABLE contact_channel_identities
  DROP COLUMN IF EXISTS derived_from_identity_id;
