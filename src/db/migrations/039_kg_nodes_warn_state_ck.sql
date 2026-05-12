-- 039_kg_nodes_warn_state_ck.sql
-- Enforces that warned_at and warn_reason are always set or cleared together.
-- Without this constraint it's possible to have warned_at IS NULL with a stale
-- warn_reason (or vice versa), producing ambiguous warn-state logic downstream.
ALTER TABLE kg_nodes ADD CONSTRAINT kg_nodes_warn_state_ck
  CHECK (
    (warned_at IS NULL AND warn_reason IS NULL)
    OR (warned_at IS NOT NULL AND warn_reason IS NOT NULL)
  );
