-- Up Migration

-- Step 1: Build a map of (duplicate_id → canonical_id) for all non-fact node groups
-- with more than one member. Canonical = highest confidence, ties by oldest created_at.
CREATE TEMP TABLE _kg_node_canonical AS
SELECT
  dup.id   AS duplicate_id,
  canon.id AS canonical_id
FROM kg_nodes dup
JOIN (
  -- One canonical node per (lower(label), type) group
  SELECT DISTINCT ON (lower(label), type)
    id,
    lower(label) AS lower_label,
    type
  FROM kg_nodes
  WHERE type != 'fact'
  ORDER BY lower(label), type, confidence DESC, created_at ASC
) canon
  ON  lower(dup.label) = canon.lower_label
  AND dup.type         = canon.type
  AND dup.id          != canon.id
WHERE dup.type != 'fact';

-- Step 2: Delete edges that would conflict with the bidirectional unique index
-- after re-pointing. An edge conflicts if the canonical already has an edge of
-- the same type connecting the same two node IDs in either direction.
DELETE FROM kg_edges e
USING _kg_node_canonical m
WHERE (e.source_node_id = m.duplicate_id OR e.target_node_id = m.duplicate_id)
  AND EXISTS (
    SELECT 1 FROM kg_edges existing
    WHERE existing.id != e.id
      AND existing.type = e.type
      AND LEAST(existing.source_node_id::text, existing.target_node_id::text) =
            LEAST(
              CASE WHEN e.source_node_id = m.duplicate_id THEN m.canonical_id ELSE e.source_node_id END,
              CASE WHEN e.target_node_id = m.duplicate_id THEN m.canonical_id ELSE e.target_node_id END
            )::text
      AND GREATEST(existing.source_node_id::text, existing.target_node_id::text) =
            GREATEST(
              CASE WHEN e.source_node_id = m.duplicate_id THEN m.canonical_id ELSE e.source_node_id END,
              CASE WHEN e.target_node_id = m.duplicate_id THEN m.canonical_id ELSE e.target_node_id END
            )::text
  );

-- Step 3: Re-point remaining edges to the canonical node
UPDATE kg_edges
SET source_node_id = m.canonical_id
FROM _kg_node_canonical m
WHERE source_node_id = m.duplicate_id;

UPDATE kg_edges
SET target_node_id = m.canonical_id
FROM _kg_node_canonical m
WHERE target_node_id = m.duplicate_id;

-- Step 4: Re-point contacts.kg_node_id to canonical.
-- If the canonical node already has a contact, NULL out the duplicate's FK
-- to avoid violating the partial unique index on contacts(kg_node_id).
-- The nulled-out contact row should be merged via the contact-merge flow.
UPDATE contacts
SET kg_node_id = CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM contacts c2
    WHERE c2.kg_node_id = m.canonical_id
      AND c2.id != contacts.id
  ) THEN m.canonical_id
  ELSE NULL
END
FROM _kg_node_canonical m
WHERE contacts.kg_node_id = m.duplicate_id;

-- Step 5: Delete duplicate nodes (ON DELETE CASCADE removes remaining edges)
DELETE FROM kg_nodes
WHERE id IN (SELECT duplicate_id FROM _kg_node_canonical);

DROP TABLE _kg_node_canonical;

-- Step 6: Enforce uniqueness going forward.
-- Excludes fact nodes — facts are intentionally many-per-entity.
-- Allows same label under different types (e.g. "Apple" org vs "Apple" concept).
CREATE UNIQUE INDEX idx_kg_nodes_unique
  ON kg_nodes (lower(label), type)
  WHERE type != 'fact';

-- Down Migration
DROP INDEX IF EXISTS idx_kg_nodes_unique;
-- Note: the dedup data changes are not reversible.
