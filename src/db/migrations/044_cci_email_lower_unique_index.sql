-- Migration 044: Case-insensitive unique index on contact_channel_identities email identifiers.
--
-- Background: contact-lookup and resolveByChannelIdentity now use LOWER() when searching
-- by email channel to handle mixed-case email addresses. Without a functional index,
-- the LOWER() predicate causes a sequential scan on the full table.
--
-- This migration adds a functional index on (channel, LOWER(channel_identifier)) scoped
-- to the email channel. It also enforces uniqueness at the DB level, closing the gap
-- where linkIdentity could theoretically insert both 'Jenna@Acme.com' and 'jenna@acme.com'
-- as separate rows (both pass the original exact-match UNIQUE constraint).
--
-- Non-email channels (phone, signal, telegram) are left with the original exact-match
-- constraint; their identifiers may be legitimately case-sensitive.
--
-- Dedup step: if legacy data contains case-variant duplicates for the same email
-- address, the unique index creation would fail. We deterministically keep the row
-- with the lowest UUID (arbitrary but stable) and delete the rest before building
-- the index.

-- Step 1: Remove case-variant duplicate email identities (keep lowest id per group).
-- Cast to text because PostgreSQL has no built-in MIN() aggregate for uuid.
DELETE FROM contact_channel_identities
WHERE channel = 'email'
  AND id::text NOT IN (
    SELECT MIN(id::text)
    FROM contact_channel_identities
    WHERE channel = 'email'
    GROUP BY channel, LOWER(channel_identifier)
  );

-- Step 2: Normalize surviving email identifiers to lowercase (aligns stored data
-- with the write-time normalization added to linkIdentity in this release).
UPDATE contact_channel_identities
SET channel_identifier = LOWER(channel_identifier)
WHERE channel = 'email'
  AND channel_identifier <> LOWER(channel_identifier);

-- Step 3: Create the unique functional index.
-- NOTE: Cannot use CONCURRENTLY inside a transaction (node-pg-migrate wraps each
-- migration file in a transaction by default). The index is small (email-only subset)
-- so a regular CREATE INDEX is acceptable; for very large tables, split this into a
-- separate non-transactional migration.
CREATE UNIQUE INDEX idx_cci_email_lower_unique
  ON contact_channel_identities (channel, LOWER(channel_identifier))
  WHERE channel = 'email';
