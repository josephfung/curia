-- 038_add_kg_node_aliases.sql
--
-- Adds an aliases column to kg_nodes for fuzzy entity resolution (#467).
-- Stores lowercased name variants so exact-match resolution catches
-- previously-confirmed name variants without an embedding call.
--
-- The GIN index supports efficient ANY() containment queries on the array.

ALTER TABLE kg_nodes ADD COLUMN aliases TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_kg_nodes_aliases ON kg_nodes USING GIN (aliases);
