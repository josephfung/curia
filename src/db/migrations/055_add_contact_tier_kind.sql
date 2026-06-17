-- Up Migration
--
-- Issue #945: Add unified `tier` + `kind` columns to the contacts table.
--
-- DEPRECATION NOTE: The legacy `status` and `trust_level` columns are kept in place
-- intentionally — they are NOT dropped in this migration (that happens in #955).
-- New code reads `tier`; legacy code and any parallel branches still reading `status`
-- are unaffected. Dual-writing both old and new columns keeps the change reversible.
--
-- Tier ordering (ascending trust):
--   blocked < unknown < known < trusted < principal
--
-- Mapping from legacy columns:
--   trust_level='ceo'  / system_role='principal'  → tier='principal'
--   trust_level='high'                             → tier='trusted'
--   trust_level='medium' OR status='confirmed'     → tier='known'
--   trust_level='low'  OR status='provisional'     → tier='unknown'
--   status='blocked'                               → tier='blocked'
--
-- Kind values:
--   'principal'    — the human CEO that Curia serves (matches system_role='principal')
--   'agent'        — Curia itself or another autonomous agent (matches system_role='agent')
--   'organization' — a company or institution (linked KG node type='organization')
--   'person'       — individual human contact (default for all others)
--   'automated'    — automated sender (e.g. mailing list); opts out of tier gates in #953

-- Add the tier column with CHECK constraint and a sensible default.
-- Existing rows will be 'unknown' until the backfill UPDATE below runs.
ALTER TABLE contacts ADD COLUMN tier TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE contacts ADD CONSTRAINT contacts_tier_check
  CHECK (tier IN ('blocked', 'unknown', 'known', 'trusted', 'principal'));

-- Add the kind column with CHECK constraint.
-- Existing rows will be 'person' until the backfill UPDATE below runs.
ALTER TABLE contacts ADD COLUMN kind TEXT NOT NULL DEFAULT 'person';
ALTER TABLE contacts ADD CONSTRAINT contacts_kind_check
  CHECK (kind IN ('person', 'organization', 'automated', 'principal', 'agent'));

-- Index for filtering/sorting by tier — most dispatch-time queries filter on tier.
-- Exclude 'unknown' (the high-cardinality default) to keep the index small and useful
-- for the cases that matter: confirming who is trusted/principal/known/blocked.
CREATE INDEX idx_contacts_tier ON contacts (tier) WHERE tier != 'unknown';

-- Backfill tier from legacy columns.
--
-- Priority rules (checked in order, most specific first):
-- 1. system_role='principal' → tier='principal'  (structural authority, trumps trust_level)
-- 2. status='blocked'         → tier='blocked'
-- 3. status='provisional'     → tier='unknown'   (BEFORE trust_level branches — the old
--                                                  authorization.ts gate refused to authorize
--                                                  ANY provisional contact, so an elevated
--                                                  trust_level on a provisional row must not
--                                                  inflate the tier to 'known' or 'trusted')
-- 4. trust_level='ceo'        → tier='principal'  (deprecated ceo trust level)
-- 5. trust_level='high'       → tier='trusted'
-- 6. trust_level='medium'     → tier='known'
-- 7. status='confirmed'       → tier='known'      (CEO approved but no explicit trust level)
-- 8. trust_level='low'        → tier='unknown'
-- (default 'unknown' already set above — no final ELSE branch needed)
UPDATE contacts
SET tier = CASE
  WHEN system_role = 'principal'   THEN 'principal'
  WHEN status      = 'blocked'     THEN 'blocked'
  WHEN status      = 'provisional' THEN 'unknown'
  WHEN trust_level = 'ceo'         THEN 'principal'
  WHEN trust_level = 'high'        THEN 'trusted'
  WHEN trust_level = 'medium'      THEN 'known'
  WHEN status      = 'confirmed'   THEN 'known'
  WHEN trust_level = 'low'         THEN 'unknown'
  ELSE                                  'unknown'
END;

-- Backfill kind from system_role and linked KG node type.
--
-- Priority rules:
-- 1. system_role='principal' → kind='principal'
-- 2. system_role='agent'     → kind='agent'
-- 3. linked KG node type='organization' → kind='organization'
-- 4. all others              → kind='person'   (default already set above)
UPDATE contacts c
SET kind = CASE
  WHEN c.system_role = 'principal'  THEN 'principal'
  WHEN c.system_role = 'agent'      THEN 'agent'
  WHEN EXISTS (
    SELECT 1 FROM kg_nodes k
    WHERE k.id = c.kg_node_id AND k.type = 'organization'
  )                                 THEN 'organization'
  ELSE                                   'person'
END
WHERE c.system_role IS NOT NULL
   OR c.kg_node_id IS NOT NULL;
-- (contacts with NULL system_role and NULL kg_node_id keep kind='person', the default)

-- Down Migration
--
-- Reverses the schema additions only. The legacy `status`/`trust_level` columns
-- were never touched by the Up migration, so they need no restoration here.
-- Dropping the columns automatically drops their CHECK constraints and the
-- partial index, but we drop the index explicitly first for clarity.
DROP INDEX IF EXISTS idx_contacts_tier;
ALTER TABLE contacts DROP COLUMN IF EXISTS tier;
ALTER TABLE contacts DROP COLUMN IF EXISTS kind;
