-- #45: preserve grant→revoke→re-grant audit history on contact_auth_overrides.
-- The table-level UNIQUE(contact_id, permission) covered revoked rows, so
-- ON CONFLICT DO UPDATE reactivated old rows instead of inserting new ones.

ALTER TABLE contact_auth_overrides
  DROP CONSTRAINT contact_auth_overrides_contact_id_permission_key;

DROP INDEX IF EXISTS idx_cao_contact_perm;

CREATE UNIQUE INDEX contact_auth_overrides_active_unique
  ON contact_auth_overrides (contact_id, permission)
  WHERE revoked_at IS NULL;
