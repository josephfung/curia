-- Up Migration
--
-- Issue #955 / #1070: Drop the legacy contact capability columns and the
-- never-used held_messages table.
--
-- Column history:
--   contacts.status     — retired in #955. New contacts are created at
--                         tier='unknown' (was status='provisional'); the
--                         old "confirmed / blocked / provisional" vocabulary
--                         is fully superseded by the tier model (migration 055).
--   contacts.trust_level — retired in #1070. All readers and writers have
--                         been ported to tier (ContactTier); setTrustLevel(),
--                         deriveTierFromTrustLevelUpdate(), and meetsMinimumTrust()
--                         are gone. The column sat dormant since that PR merged.
--
-- Table history:
--   held_messages — the hold-and-notify flow was deleted in #947 (HeldMessageService,
--                   held-messages-list, held-messages-process all removed). The table
--                   has been unreferenced since then. Migration 056 already converted
--                   its contacts FK to ON DELETE SET NULL, so no FK constraint
--                   blocks this DROP. No other table references held_messages.

ALTER TABLE contacts DROP COLUMN IF EXISTS status;
ALTER TABLE contacts DROP COLUMN IF EXISTS trust_level;
DROP TABLE IF EXISTS held_messages;

-- Down Migration
--
-- Schema-only rollback. Legacy VALUES are not restorable — tier/kind are the
-- source of truth post-cutover. Columns return nullable with no constraint
-- (the legacy CHECK constraints are not worth restoring for a dead column).
--
-- NOTE: held_messages is intentionally NOT recreated on rollback. The hold
-- machinery (HeldMessageService, skills, coordinator prompts) was deleted in
-- #947; recreating the empty table would be misleading and serve no purpose.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS trust_level TEXT;
