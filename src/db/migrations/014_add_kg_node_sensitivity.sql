-- Up Migration

-- Add sensitivity classification to KG nodes per issue #200.
-- This is the foundational piece for bulk export controls (#201).
--
-- Default is 'internal' — the least permissive safe default that still allows
-- normal operations. Callers that don't specify a sensitivity level get 'internal',
-- not 'public', so unclassified data is protected by default.
--
-- Valid values: 'public' | 'internal' | 'confidential' | 'restricted'
-- Enforced both at the DB level (CHECK constraint) and the application layer
-- (Sensitivity type in src/memory/types.ts) so that direct SQL writes and
-- future code paths cannot persist an invalid value that would confuse export gates.

ALTER TABLE kg_nodes ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted'));

-- Index for export gate queries: "give me all nodes above sensitivity X"
CREATE INDEX idx_kg_nodes_sensitivity ON kg_nodes (sensitivity);

-- Down Migration

DROP INDEX IF EXISTS idx_kg_nodes_sensitivity;
ALTER TABLE kg_nodes DROP COLUMN IF EXISTS sensitivity;
