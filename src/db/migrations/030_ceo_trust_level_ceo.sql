-- Migration 030: Widen trust_level check constraint to include the 'ceo' tier
--
-- Schema change only — no data migration. The CEO contact's trust_level is set to
-- 'ceo' by the bootstrap process (src/contacts/ceo-bootstrap.ts), which resolves
-- the CEO contact by email address (config.ceoPrimaryEmail) and uses the contact's
-- own id — not a role/title comparison — to perform the update. The bootstrap is
-- idempotent and runs on every startup, so no SQL data migration is needed here.
--
-- This migration must run before the first startup that expects trust_level = 'ceo'
-- to be a valid value in the check constraint.
--
-- Reversal (drops 'ceo' from the allowed set — only safe after bootstrap is reverted):
--   ALTER TABLE contacts DROP CONSTRAINT contacts_trust_level_check;
--   ALTER TABLE contacts ADD CONSTRAINT contacts_trust_level_check
--     CHECK (trust_level IN ('high', 'medium', 'low') OR trust_level IS NULL);

ALTER TABLE contacts DROP CONSTRAINT contacts_trust_level_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_trust_level_check
  CHECK (trust_level IN ('ceo', 'high', 'medium', 'low') OR trust_level IS NULL);
