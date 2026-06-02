-- Up Migration

ALTER TABLE contacts ADD COLUMN preferred_name  TEXT;
ALTER TABLE contacts ADD COLUMN title           TEXT;
ALTER TABLE contacts ADD COLUMN organization    TEXT;
ALTER TABLE contacts ADD COLUMN primary_email   TEXT;
ALTER TABLE contacts ADD COLUMN primary_phone   TEXT;
ALTER TABLE contacts ADD COLUMN timezone        TEXT;
ALTER TABLE contacts ADD COLUMN locale          TEXT;
ALTER TABLE contacts ADD COLUMN location        TEXT;
ALTER TABLE contacts ADD COLUMN pronouns        TEXT;
ALTER TABLE contacts ADD COLUMN linkedin_url    TEXT;
ALTER TABLE contacts ADD COLUMN bio             TEXT;
ALTER TABLE contacts ADD COLUMN birthday        TEXT;

ALTER TABLE contacts ADD CONSTRAINT contacts_primary_email_format_check
  CHECK (primary_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
ALTER TABLE contacts ADD CONSTRAINT contacts_linkedin_url_format_check
  CHECK (linkedin_url ~ '^https?://');
ALTER TABLE contacts ADD CONSTRAINT contacts_bio_length_check
  CHECK (char_length(bio) <= 500);
ALTER TABLE contacts ADD CONSTRAINT contacts_birthday_format_check
  CHECK (birthday ~ '^\d{4}-\d{2}-\d{2}$' OR birthday ~ '^--\d{2}-\d{2}$');
ALTER TABLE contacts ADD CONSTRAINT contacts_primary_phone_format_check
  CHECK (primary_phone ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE contacts ADD CONSTRAINT contacts_locale_format_check
  CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2,4})?$');

-- Rollback: ALTER TABLE contacts
--   DROP COLUMN preferred_name, DROP COLUMN title, DROP COLUMN organization,
--   DROP COLUMN primary_email, DROP COLUMN primary_phone, DROP COLUMN timezone,
--   DROP COLUMN locale, DROP COLUMN location, DROP COLUMN pronouns,
--   DROP COLUMN linkedin_url, DROP COLUMN bio, DROP COLUMN birthday;
