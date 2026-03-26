-- Up Migration

-- Contacts: thin index over KG person nodes for fast dispatch-time lookups.
-- Rich context about a person lives in the KG — these tables handle
-- identity resolution, verification, and authorization overrides.
CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kg_node_id      UUID REFERENCES kg_nodes(id),
  display_name    TEXT NOT NULL,
  role            TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contacts_kg_node ON contacts (kg_node_id) WHERE kg_node_id IS NOT NULL;
CREATE INDEX idx_contacts_role ON contacts (role) WHERE role IS NOT NULL;
CREATE INDEX idx_contacts_display_name ON contacts (lower(display_name));

-- Channel identities: maps (channel, identifier) → contact.
-- One contact can have multiple identifiers per channel (work + personal email).
-- UNIQUE constraint prevents two different contacts from claiming the same identifier.
CREATE TABLE contact_channel_identities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL,
  channel_identifier  TEXT NOT NULL,
  label               TEXT,
  verified            BOOLEAN NOT NULL DEFAULT false,
  verified_at         TIMESTAMPTZ,
  source              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(channel, channel_identifier)
);

CREATE INDEX idx_cci_contact ON contact_channel_identities (contact_id);

-- Authorization overrides: per-contact grants/denials that override role defaults.
-- Phase B will implement the authorization check flow; for now we just create the table.
CREATE TABLE contact_auth_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  permission      TEXT NOT NULL,
  granted         BOOLEAN NOT NULL,
  granted_by      TEXT NOT NULL DEFAULT 'ceo',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,

  UNIQUE(contact_id, permission)
);

CREATE INDEX idx_cao_contact_perm ON contact_auth_overrides (contact_id, permission)
  WHERE revoked_at IS NULL;
