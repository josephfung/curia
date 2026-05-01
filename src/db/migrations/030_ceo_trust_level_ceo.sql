-- Migration 030: Elevate CEO contact trust level from 'high' to 'ceo'
--
-- The 'ceo' level sits above 'high' in the ordinal ranking, enabling
-- trust-based policy decisions (e.g. PII redaction bypass) that should
-- only apply to the principal, not all high-trust contacts.
--
-- Reversal: UPDATE contacts SET trust_level = 'high'
--           WHERE trust_level = 'ceo' AND role = 'ceo';

UPDATE contacts
SET    trust_level = 'ceo',
       updated_at  = now()
WHERE  trust_level = 'high'
AND    role = 'ceo';
