-- Migration 045: Normalize phone/signal channel identifiers to E.164 format
-- and add a CHECK constraint to prevent future format drift.
--
-- Background: During the 2026-05-26 wrong-recipient incident (#727), Xiaopu Fung's
-- phone channel identifier was found to be stored as '+1-519-504-0098' (dash-formatted)
-- instead of canonical E.164 '+15195040098'. A post-incident audit (issue #731) found
-- 5 total format violations across 8 phone/signal rows, all on the 'phone' channel.
-- Signal rows were already E.164 (signal-cli delivers them that way).
--
-- Audit results (2026-05-26):
--   Format violations:    5 rows (all channel='phone', all verified=true)
--   Exact collisions:     0 rows
--   Cross-channel clashes (same number, different contacts): 0 rows
--   Stale verified rows (>6 months, legacy format):          0 rows
--
-- Violations found and their normalized forms:
--   Evan Fung         '+1 (226) 989-6622'  → '+12269896622'  (spaces + parens)
--   Xiaopu Fung       '+1-519-504-0098'    → '+15195040098'  (dashes)
--   Sandra Hanmer     '519-574-0061'       → '+15195740061'  (missing +1, dashes)
--   Jacqui Murphy     '519-574-2973'       → '+15195742973'  (missing +1, dashes)
--   Sheldon McCormick '647.389.4377'       → '+16473894377'  (missing +1, dots)
--
-- Fix strategy:
--   Step 1: Normalize numbers that already carry a '+' prefix — strip all non-digit
--           characters after the '+', leaving a pure E.164 string.
--   Step 2: For 10-digit NANP numbers without a '+' prefix (area codes 200-999),
--           prepend '+1'. All three uncoded rows were confirmed as Canadian NANP
--           numbers (area codes 519 = Ontario, 647 = Toronto).
--   Step 3: Add a CHECK constraint so future inserts/updates with non-E.164
--           phone/signal identifiers are rejected at the database level.
--
-- Application-level normalization (see contact-service.ts linkIdentity) is added
-- alongside this migration to normalize at write time before the constraint fires.
--
-- Down Migration:
--   The data normalization steps are NOT reversible (original strings are not kept).
--   The CHECK constraint can be dropped:
--     ALTER TABLE contact_channel_identities
--       DROP CONSTRAINT cci_phone_signal_e164_format;

-- Step 1: Normalize phone/signal identifiers that already have a '+' prefix.
-- Strip all non-digit characters after the leading '+'.
UPDATE contact_channel_identities
SET
  channel_identifier = '+' || regexp_replace(substring(channel_identifier FROM 2), '[^0-9]', '', 'g'),
  updated_at         = now()
WHERE channel IN ('phone', 'signal')
  AND channel_identifier LIKE '+%'
  AND channel_identifier !~ '^\+[1-9][0-9]{6,14}$';

-- Step 2: Normalize 10-digit NANP phone/signal identifiers that have no '+' prefix.
-- These are confirmed North American numbers; prepend country code +1.
-- Guard: digit-only form must be exactly 10 digits starting with a valid NANP area
-- code digit (2–9) to avoid misidentifying already-short or malformed values.
UPDATE contact_channel_identities
SET
  channel_identifier = '+1' || regexp_replace(channel_identifier, '[^0-9]', '', 'g'),
  updated_at         = now()
WHERE channel IN ('phone', 'signal')
  AND channel_identifier NOT LIKE '+%'
  AND regexp_replace(channel_identifier, '[^0-9]', '', 'g') ~ '^[2-9][0-9]{9}$';

-- Step 3: Add a CHECK constraint enforcing E.164 format for phone and signal channels.
-- Regex: '+' followed by 7–15 digits, first digit non-zero (country code cannot be 0).
-- The 7-digit floor is stricter than the ITU minimum (2 digits) but matches the
-- shortest real PSTN subscriber numbers; it intentionally rejects obviously-malformed
-- values like bare country codes. Other channels are unaffected.
ALTER TABLE contact_channel_identities
  ADD CONSTRAINT cci_phone_signal_e164_format
  CHECK (
    channel NOT IN ('phone', 'signal')
    OR channel_identifier ~ '^\+[1-9][0-9]{6,14}$'
  );
