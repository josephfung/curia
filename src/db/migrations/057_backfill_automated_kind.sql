-- Migration 057: backfill kind='automated' for existing contacts whose primary
-- email address matches known automated sender patterns.
--
-- Touches both kind='organization' rows (noreply addresses classified as org
-- before this migration) and kind='person' rows (contacts created before the
-- classifier existed). Idempotent: contacts already at kind='automated' are
-- skipped via the WHERE clause.
--
-- The regex covers the same set of patterns as AUTOMATED_LOCAL_RE in contact-service.ts.
-- Keep both in sync if patterns are ever extended.

UPDATE contacts
SET kind = 'automated', updated_at = now()
WHERE id IN (
  SELECT c.id
  FROM contacts c
  JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE cci.channel = 'email'
    AND cci.channel_identifier ~* '^(noreply|no[_.-]?reply|donotreply|do[_.-]not[_.-]?reply|mailer[_.-]?daemon|mailerdaemon|notifications?|alerts?|newsletters?|updates?|bounced?|bounces?|unsubscribe|postmaster|automated|auto)@'
    AND c.kind != 'automated'
);
