-- 036_add_identity_status.sql
--
-- Add status column to contact_channel_identities.
-- Tracks whether an identity (email, phone) is usable: active, defunct, or bounced.
-- Orthogonal to the existing `verified` boolean (which tracks ownership confirmation).
-- See: https://github.com/josephfung/curia/issues/377

ALTER TABLE contact_channel_identities
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE contact_channel_identities
  ADD CONSTRAINT contact_channel_identities_status_check
    CHECK (status IN ('active', 'defunct', 'bounced'));
