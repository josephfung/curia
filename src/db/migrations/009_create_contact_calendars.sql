-- Up Migration

-- Calendar registry: maps Nylas calendar IDs to contacts.
-- A contact can have multiple calendars (work, personal, etc.).
-- Nullable contact_id supports org-wide calendars (holidays, rooms).
CREATE TABLE contact_calendars (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nylas_calendar_id TEXT NOT NULL UNIQUE,
  contact_id        UUID REFERENCES contacts(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  read_only         BOOLEAN NOT NULL DEFAULT false,
  timezone          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one primary calendar per contact.
-- Partial unique index: only rows where is_primary = true participate.
CREATE UNIQUE INDEX idx_contact_calendars_primary
  ON contact_calendars (contact_id) WHERE is_primary = true;

-- Fast lookup by contact for "get calendars for this person" queries.
CREATE INDEX idx_contact_calendars_contact
  ON contact_calendars (contact_id) WHERE contact_id IS NOT NULL;
