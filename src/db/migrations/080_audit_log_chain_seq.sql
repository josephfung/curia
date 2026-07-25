-- Up Migration
--
-- Decouple hash-chain order from wall-clock timestamp (#1540 review).
-- `timestamp` stays the factual event time; `seq` is the monotonic chain key.
--
-- Temporarily disables the append-only trigger for a one-time backfill of seq
-- on existing rows (ordered by timestamp, id — the previous verify walk order).
-- Re-enables the trigger before commit and extends it to treat seq as immutable.

ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable_trigger;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq BIGINT;

-- Backfill in the order the Phase-1 verify tool previously walked. For rows
-- written under the (now-removed) timestamp-bump logic this matches write order.
UPDATE audit_log AS a
SET seq = o.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY timestamp ASC, id ASC) AS rn
  FROM audit_log
) AS o
WHERE a.id = o.id
  AND a.seq IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S' AND c.relname = 'audit_log_seq_seq' AND n.nspname = 'public'
  ) THEN
    CREATE SEQUENCE public.audit_log_seq_seq;
  END IF;
END $$;

-- Align the sequence with the highest backfilled seq. On an empty table,
-- leave the sequence at its default (next nextval → 1): setval(..., 0) fails
-- with 22003 because ascending sequences have minvalue 1.
DO $$
DECLARE
  max_seq bigint;
BEGIN
  SELECT MAX(seq) INTO max_seq FROM audit_log;
  IF max_seq IS NOT NULL THEN
    PERFORM setval('public.audit_log_seq_seq', max_seq, true);
  END IF;
END $$;

ALTER TABLE audit_log ALTER COLUMN seq SET DEFAULT nextval('public.audit_log_seq_seq');
ALTER TABLE audit_log ALTER COLUMN seq SET NOT NULL;
ALTER SEQUENCE public.audit_log_seq_seq OWNED BY audit_log.seq;

-- Unique index on seq is created CONCURRENTLY in 081_audit_log_structured_indexes.js
-- (cannot run inside this transactional SQL migration). Application writes are still
-- serialized by the advisory lock; uniqueness is enforced once 081 lands.

-- seq is immutable once written (same rules as every other audit column).
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
    AND (OLD.seq              IS NOT DISTINCT FROM NEW.seq)
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_log is append-only: % operations are not permitted (only acknowledged false→true is allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable_trigger;

-- NOTE on lock window: DISABLE TRIGGER … ENABLE TRIGGER requires ACCESS EXCLUSIVE
-- for the backfill of an otherwise-immutable table. At current throughput
-- (~425 events/day) the window is short. Splitting into a noTransaction migration
-- would leave a partially backfilled seq on failure — worse than a brief exclusive
-- lock. Do not remove the surrounding transaction.

-- Down Migration
--
-- NOTE: This restores the post-078 / pre-080 trigger body (seq absent). If a
-- later migration edits audit_log_immutable without updating this down path,
-- rollback will silently reintroduce drift — keep them in sync.
-- idx_audit_log_seq is dropped in 081's down path.

ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable_trigger;

ALTER TABLE audit_log DROP COLUMN IF EXISTS seq;
DROP SEQUENCE IF EXISTS public.audit_log_seq_seq;

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

ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable_trigger;
