-- Up Migration
--
-- Enforce audit_log append-only at the database level.
--
-- The audit log is immutable by design: no UPDATE or DELETE is ever permitted
-- on a persisted row, with exactly one exception — the delivery acknowledgement
-- path is allowed to flip `acknowledged` from false to true once per row.
--
-- This trigger runs BEFORE any UPDATE or DELETE so the operation is rejected
-- before it reaches storage. Using a RAISE EXCEPTION (rather than a silent
-- DO INSTEAD NOTHING rule) makes accidental mutations visible immediately
-- rather than silently disappearing.

CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS trigger AS $$
BEGIN
  -- The only permitted mutation: marking a row as acknowledged (false → true).
  -- All other columns must remain identical to prevent any partial update from
  -- sneaking through by bundling with the acknowledged flip.
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

CREATE TRIGGER audit_log_immutable_trigger
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
