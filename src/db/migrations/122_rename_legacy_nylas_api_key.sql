-- 122_rename_legacy_nylas_api_key.sql
--
-- Retire the flat nylas_api_key vault name (#2522). Older installs seeded it; the email
-- channel, calendar and the ceo-inbox tools now read only channel.email.nylas_api_key.
-- Rename the row when only the legacy one exists. A row that already has the canonical
-- name wins and both are left as they are; the leftover legacy row then shows on the
-- Secrets page as an ordinary orphan the operator can delete.
--
-- Known gap: the guard cannot tell a blank canonical row from a real one (that needs the
-- key to decrypt). An install with a blank channel.email.nylas_api_key row and a valid flat
-- key keeps the blank row, and email reports the key missing; re-save it in Settings >
-- Channels > Email. Readers trim the value and treat blank as absent.
--
-- The vault encrypts with AES-256-GCM and binds no AAD to the name, so the ciphertext and
-- IV carry over unchanged and no key is needed here.
--
-- nylas_grant_id and nylas_self_email are not migrated: nothing reads them since
-- multi-account email (grants live at channel.email.<name>.nylas_grant_id).

-- Up Migration

UPDATE secrets
   SET name = 'channel.email.nylas_api_key'
 WHERE name = 'nylas_api_key'
   AND NOT EXISTS (SELECT 1 FROM secrets WHERE name = 'channel.email.nylas_api_key');

-- Down Migration

-- No-op: after the rename there is no way to tell a migrated row from one the console
-- wrote, and the code before this migration reads channel.email.nylas_api_key first.
SELECT 1;
