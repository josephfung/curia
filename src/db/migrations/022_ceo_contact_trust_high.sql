-- Up Migration

-- Backfill trust_level = 'high' for existing CEO contacts.
--
-- The outbound content filter's contact-data-leak rule uses trust_level to decide
-- whether a recipient may receive third-party email addresses in outbound content.
-- Without trust_level = 'high', any email address linked to the CEO contact (e.g. a
-- second address after a domain change) would not match the single CEO_PRIMARY_EMAIL
-- config string, causing legitimate messages to be blocked.
--
-- The CEO bootstrap now sets trust_level = 'high' on create and promotion, so this
-- migration only needs to patch records created before that change landed.
UPDATE contacts
SET    trust_level = 'high',
       updated_at  = now()
WHERE  role = 'ceo'
AND    trust_level IS NULL;
