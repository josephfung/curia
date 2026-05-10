-- 035_add_system_role.sql
--
-- Adds a system_role column to contacts to separate system designation
-- ('principal', 'agent') from the free-text descriptive role field.
-- See design doc: docs/wip/2026-05-10-principal-identity-design.md

-- Add column with check constraint
ALTER TABLE contacts
  ADD COLUMN system_role TEXT
  CHECK (system_role IN ('principal', 'agent'));

-- Only one principal (the human Curia serves)
CREATE UNIQUE INDEX idx_contacts_system_role_principal
  ON contacts (system_role)
  WHERE system_role = 'principal';

-- Only one agent (Curia itself)
CREATE UNIQUE INDEX idx_contacts_system_role_agent
  ON contacts (system_role)
  WHERE system_role = 'agent';

-- Backfill from existing data.
-- Production has exactly one role='ceo' and one role='agent'.
UPDATE contacts SET system_role = 'principal' WHERE role = 'ceo';
UPDATE contacts SET system_role = 'agent' WHERE role = 'agent';
