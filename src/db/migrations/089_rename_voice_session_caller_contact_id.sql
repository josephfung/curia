-- Up Migration
-- voice_sessions.principal_contact_id stores the resolved caller contact id,
-- including non-principal callers (Signal unknown-sender allow, #1672).
-- Rename so the column matches its contents (#1629).
--
-- RENAME COLUMN preserves existing rows and the FK from migration 082
-- (ON DELETE SET NULL). Do not drop and recreate the column. Postgres does
-- not rename constraints with the column, so the FK is renamed here too —
-- the generated name still said "principal".
--
-- Guards match migration 075. node-pg-migrate records pgmigrations and will
-- not apply this twice on the boot path; the EXISTS checks survive a partial
-- apply or a hand re-run (RAISE-free no-op instead of a second ALTER error).
--
-- Not backward compatible: an image rollback past this migration does not
-- run the down section. The database stays at caller_contact_id while the
-- old code inserts principal_contact_id, and voice session create throws
-- until this down section is run by hand.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'voice_sessions'
      AND column_name = 'principal_contact_id'
  ) THEN
    ALTER TABLE voice_sessions
      RENAME COLUMN principal_contact_id TO caller_contact_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'voice_sessions'::regclass
      AND conname = 'voice_sessions_principal_contact_id_fkey'
      AND contype = 'f'
  ) THEN
    ALTER TABLE voice_sessions
      RENAME CONSTRAINT voice_sessions_principal_contact_id_fkey
                     TO voice_sessions_caller_contact_id_fkey;
  END IF;
END $$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'voice_sessions'::regclass
      AND conname = 'voice_sessions_caller_contact_id_fkey'
      AND contype = 'f'
  ) THEN
    ALTER TABLE voice_sessions
      RENAME CONSTRAINT voice_sessions_caller_contact_id_fkey
                     TO voice_sessions_principal_contact_id_fkey;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'voice_sessions'
      AND column_name = 'caller_contact_id'
  ) THEN
    ALTER TABLE voice_sessions
      RENAME COLUMN caller_contact_id TO principal_contact_id;
  END IF;
END $$;
