-- Up Migration
--
-- Phase 1 audit log hardening (#1383 / spec 10):
--   - Structured query columns (action, outcome, target_*, initiator_*)
--   - entry_hash for SHA-256 hash-chain tamper evidence
--   - Extend the append-only trigger so acknowledgement flips still require
--     all immutable columns (including the new ones) to be unchanged
--
-- All new columns are nullable. Historical rows stay NULL — migration 021's
-- trigger blocks UPDATEs, so backfill is impossible. Readers must fall back
-- to the JSONB payload for pre-hardening rows.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS action         TEXT,
  ADD COLUMN IF NOT EXISTS outcome        TEXT,
  ADD COLUMN IF NOT EXISTS target_type    TEXT,
  ADD COLUMN IF NOT EXISTS target_id      TEXT,
  ADD COLUMN IF NOT EXISTS initiator_type TEXT,
  ADD COLUMN IF NOT EXISTS initiator_id   TEXT,
  ADD COLUMN IF NOT EXISTS entry_hash     TEXT;

-- Indexes for the new columns (and task_id) live in 081_audit_log_structured_indexes.js
-- so they can be built CONCURRENTLY outside a transaction (node-pg-migrate wraps
-- plain .sql files in a single transaction, which forbids CONCURRENTLY).
-- The .js wrapper (not .sql/.ts) is loadable by every migrate entry point via
-- dynamic import; --migration-file-language sql only affects `create`, not `up`.

-- Rebuild the immutability trigger so acknowledged false→true still requires every
-- column — including the new structured/hash fields — to be bitwise identical.
CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.acknowledged = false
    AND NEW.acknowledged = true
    AND OLD.id                = NEW.id
    AND OLD.timestamp         = NEW.timestamp
    AND OLD.event_type        = NEW.event_type
    AND OLD.source_layer      = NEW.source_layer
    AND OLD.source_id         = NEW.source_id
    AND OLD.payload           = NEW.payload
    AND (OLD.conversation_id  IS NOT DISTINCT FROM NEW.conversation_id)
    AND (OLD.task_id          IS NOT DISTINCT FROM NEW.task_id)
    AND (OLD.parent_event_id  IS NOT DISTINCT FROM NEW.parent_event_id)
    AND (OLD.action           IS NOT DISTINCT FROM NEW.action)
    AND (OLD.outcome          IS NOT DISTINCT FROM NEW.outcome)
    AND (OLD.target_type      IS NOT DISTINCT FROM NEW.target_type)
    AND (OLD.target_id        IS NOT DISTINCT FROM NEW.target_id)
    AND (OLD.initiator_type   IS NOT DISTINCT FROM NEW.initiator_type)
    AND (OLD.initiator_id     IS NOT DISTINCT FROM NEW.initiator_id)
    AND (OLD.entry_hash       IS NOT DISTINCT FROM NEW.entry_hash)
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_log is append-only: % operations are not permitted (only acknowledged false→true is allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- Down Migration
--
-- NOTE: Recreates the pre-078 trigger body by hand. If a later migration edits
-- audit_log_immutable (e.g. 080 adds seq) without updating this down path,
-- rolling back past that later migration first is required — otherwise this
-- down path silently reintroduces trigger drift.
-- Indexes are dropped in 081's down path (CREATE INDEX CONCURRENTLY lives there).

ALTER TABLE audit_log
  DROP COLUMN IF EXISTS entry_hash,
  DROP COLUMN IF EXISTS initiator_id,
  DROP COLUMN IF EXISTS initiator_type,
  DROP COLUMN IF EXISTS target_id,
  DROP COLUMN IF EXISTS target_type,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS action;

-- Restore the pre-078 trigger body (columns above are gone).
CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.acknowledged = false
    AND NEW.acknowledged = true
    AND OLD.id                = NEW.id
    AND OLD.timestamp         = NEW.timestamp
    AND OLD.event_type        = NEW.event_type
    AND OLD.source_layer      = NEW.source_layer
    AND OLD.source_id         = NEW.source_id
    AND OLD.payload           = NEW.payload
    AND (OLD.conversation_id  IS NOT DISTINCT FROM NEW.conversation_id)
    AND (OLD.task_id          IS NOT DISTINCT FROM NEW.task_id)
    AND (OLD.parent_event_id  IS NOT DISTINCT FROM NEW.parent_event_id)
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_log is append-only: % operations are not permitted (only acknowledged false→true is allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;
