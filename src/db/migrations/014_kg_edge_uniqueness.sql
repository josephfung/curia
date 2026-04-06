-- Up Migration

-- Remove duplicate kg_edges rows before adding the unique constraint.
-- For each bidirectional pair (LEAST(src,tgt), GREATEST(src,tgt), type), keep
-- the row with the highest confidence; break ties by most-recent last_confirmed_at.
DELETE FROM kg_edges
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY
          LEAST(source_node_id::text, target_node_id::text),
          GREATEST(source_node_id::text, target_node_id::text),
          type
        ORDER BY confidence DESC, last_confirmed_at DESC
      ) AS rn
    FROM kg_edges
  ) ranked
  WHERE rn > 1
);

-- Bidirectional unique index: treats (A→B, type) and (B→A, type) as the same edge.
-- Expression indexes require the full expression in ON CONFLICT clauses (not the index name).
CREATE UNIQUE INDEX idx_kg_edges_unique
  ON kg_edges (
    LEAST(source_node_id::text, target_node_id::text),
    GREATEST(source_node_id::text, target_node_id::text),
    type
  );

-- Down Migration
DROP INDEX IF EXISTS idx_kg_edges_unique;
