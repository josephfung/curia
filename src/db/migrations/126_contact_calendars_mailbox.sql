-- 126_contact_calendars_mailbox.sql
--
-- A registered calendar belongs to one of the principal's mailboxes (#2475, Part 4). The column is
-- nullable: org-wide calendars and calendars of other contacts have no mailbox, and existing rows
-- are assigned the default mailbox by the idempotent boot backfill (backfillCalendarMailboxes),
-- not here, because the default mailbox may not exist yet when this migration runs.
-- The one-primary-per-contact rule becomes one primary per contact per mailbox.
-- nylas_calendar_id stays globally unique (its own constraint, untouched).

-- Up Migration

ALTER TABLE contact_calendars
  ADD COLUMN principal_mailbox_id TEXT NULL REFERENCES principal_mailboxes(id);

DROP INDEX IF EXISTS idx_contact_calendars_primary;

CREATE UNIQUE INDEX idx_contact_calendars_primary_per_mailbox
  ON contact_calendars (contact_id, COALESCE(principal_mailbox_id, ''))
  WHERE is_primary;

-- Down Migration

DROP INDEX IF EXISTS idx_contact_calendars_primary_per_mailbox;

-- Restoring the single-primary index fails if a contact now has primaries in two mailboxes;
-- demote all but the oldest first.
UPDATE contact_calendars c SET is_primary = false
WHERE is_primary AND contact_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM contact_calendars o
  WHERE o.contact_id = c.contact_id AND o.is_primary
    AND (o.created_at, o.id) < (c.created_at, c.id)
);

CREATE UNIQUE INDEX idx_contact_calendars_primary
  ON contact_calendars (contact_id) WHERE is_primary = true;

ALTER TABLE contact_calendars DROP COLUMN IF EXISTS principal_mailbox_id;
