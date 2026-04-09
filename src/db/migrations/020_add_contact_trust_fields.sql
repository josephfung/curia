-- Up Migration

-- Add trust scoring fields to the contacts table.
-- contact_confidence: accumulated signal over time (0.0–1.0). Starts at 0.0 for all contacts.
-- trust_level: optional per-contact override for channel trust weight. NULL means use channel default.
-- last_seen_at: timestamp of most recent inbound message from this contact.
ALTER TABLE contacts ADD COLUMN contact_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.0;
ALTER TABLE contacts ADD COLUMN trust_level TEXT;
ALTER TABLE contacts ADD COLUMN last_seen_at TIMESTAMPTZ;

-- Index for finding high-confidence contacts (e.g. for UI display, future scoring queries)
CREATE INDEX idx_contacts_confidence ON contacts (contact_confidence) WHERE contact_confidence > 0;

-- Constraint: contact_confidence must be within the documented 0.0–1.0 range.
-- NUMERIC(3,2) limits precision but still allows -9.99–9.99 without this.
ALTER TABLE contacts ADD CONSTRAINT contacts_contact_confidence_check
  CHECK (contact_confidence >= 0.0 AND contact_confidence <= 1.0);

-- Constraint: trust_level must be a valid value when set
ALTER TABLE contacts ADD CONSTRAINT contacts_trust_level_check
  CHECK (trust_level IN ('high', 'medium', 'low') OR trust_level IS NULL);
