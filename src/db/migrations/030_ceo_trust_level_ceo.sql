-- Migration 030: Elevate CEO contact trust level from 'high' to 'ceo'
--
-- The 'ceo' level sits above 'high' in the ordinal ranking, enabling
-- trust-based policy decisions (e.g. PII redaction bypass) that should
-- only apply to the principal, not all high-trust contacts.
--
-- Requires widening the contacts_trust_level_check constraint (added in
-- migration 020) to include the new 'ceo' value before the UPDATE can run.
--
-- Reversal:
--   UPDATE contacts SET trust_level = 'high', updated_at = now()
--     WHERE trust_level = 'ceo' AND role = 'ceo';
--   ALTER TABLE contacts DROP CONSTRAINT contacts_trust_level_check;
--   ALTER TABLE contacts ADD CONSTRAINT contacts_trust_level_check
--     CHECK (trust_level IN ('high', 'medium', 'low') OR trust_level IS NULL);

-- Widen the trust_level constraint to allow the new 'ceo' tier.
ALTER TABLE contacts DROP CONSTRAINT contacts_trust_level_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_trust_level_check
  CHECK (trust_level IN ('ceo', 'high', 'medium', 'low') OR trust_level IS NULL);

-- Elevate the CEO contact to the new 'ceo' trust level.
UPDATE contacts
SET    trust_level = 'ceo',
       updated_at  = now()
WHERE  trust_level = 'high'
AND    role = 'ceo';
