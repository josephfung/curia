-- Migration 057: backfill kind='automated' for existing contacts whose primary
-- email address matches known automated sender patterns.
--
-- Touches kind='person' and kind='organization' rows only — principal and agent
-- contacts are never reclassified, even if their address happens to match a pattern.
-- Idempotent: contacts already at kind='automated' are skipped.
--
-- Uses contacts.primary_email directly (not a JOIN on contact_channel_identities)
-- so secondary/alias addresses on human contacts can never trigger a reclassification.
--
-- The regex covers the same set of patterns as AUTOMATED_LOCAL_RE in contact-service.ts.
-- Keep both in sync if patterns are ever extended.

UPDATE contacts
SET kind = 'automated', updated_at = now()
WHERE primary_email ~* '^(noreply|no[_.-]?reply|donotreply|do[_.-]not[_.-]?reply|mailer[_.-]?daemon|mailerdaemon|notifications?|alerts?|newsletters?|updates?|bounced?|bounces?|unsubscribe|postmaster|automated|auto)@'
  AND kind IN ('person', 'organization');
