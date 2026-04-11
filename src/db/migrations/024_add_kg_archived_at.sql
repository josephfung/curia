-- Up Migration

-- Add soft-delete column to knowledge graph nodes and edges (dream engine, issue #27).
-- archived_at is NULL for active rows; set to the archiving timestamp for soft-deleted rows.
-- Partial indexes on the NULL case keep read-path performance equivalent to the pre-migration
-- full-table scan — the planner uses these indexes for all WHERE archived_at IS NULL queries.

ALTER TABLE kg_nodes ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE kg_edges ADD COLUMN archived_at TIMESTAMPTZ;

-- Partial index covering active nodes only (the overwhelming majority of rows).
CREATE INDEX idx_kg_nodes_archived_at ON kg_nodes (archived_at) WHERE archived_at IS NULL;
-- Partial index covering active edges only.
CREATE INDEX idx_kg_edges_archived_at ON kg_edges (archived_at) WHERE archived_at IS NULL;

-- Recreate the node uniqueness index to exclude archived rows.
-- Without this, inserting a new node with the same label as an archived node would
-- trigger a unique violation — the old index has no knowledge of archived_at.
-- After this migration, uniqueness is enforced only among active (non-archived) nodes.
DROP INDEX IF EXISTS idx_kg_nodes_unique;
CREATE UNIQUE INDEX idx_kg_nodes_unique
  ON kg_nodes (lower(label), type)
  WHERE type != 'fact' AND archived_at IS NULL;
