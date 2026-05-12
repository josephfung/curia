-- 037_add_kg_nodes_warned_at.sql
-- Adds decay-warning state to kg_nodes.
-- warned_at: when DreamEngine flagged this node for CEO re-confirmation.
-- warn_reason: why it was flagged (high_sensitivity, high_connectivity, or both).

ALTER TABLE kg_nodes ADD COLUMN warned_at TIMESTAMPTZ;
ALTER TABLE kg_nodes ADD COLUMN warn_reason TEXT
  CHECK (warn_reason IN ('high_sensitivity', 'high_connectivity', 'both'));

-- Partial index: only covers actively-warned, non-archived nodes.
-- Keeps the decay-warnings-list skill query fast as the graph scales.
CREATE INDEX idx_kg_nodes_warned
  ON kg_nodes (warned_at)
  WHERE warned_at IS NOT NULL AND archived_at IS NULL;
