-- Up Migration

-- Knowledge graph nodes: people, organizations, projects, decisions, facts, etc.
-- The embedding column stores VECTOR(1536) from OpenAI text-embedding-3-small.
-- Temporal metadata tracks confidence, freshness, and decay class per spec 01.
CREATE TABLE kg_nodes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              TEXT NOT NULL,
  label             TEXT NOT NULL,
  properties        JSONB NOT NULL DEFAULT '{}',
  embedding         vector(1536),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence        FLOAT NOT NULL DEFAULT 0.7,
  decay_class       TEXT NOT NULL DEFAULT 'slow_decay',
  source            TEXT NOT NULL
);

-- Knowledge graph edges: relationships between nodes.
-- Temporal metadata tracks when the relationship was established and its reliability.
CREATE TABLE kg_edges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_node_id    UUID NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  target_node_id    UUID NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  properties        JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence        FLOAT NOT NULL DEFAULT 0.7,
  decay_class       TEXT NOT NULL DEFAULT 'slow_decay',
  source            TEXT NOT NULL
);

-- Primary query patterns:
-- 1. Find all nodes of a given type (e.g., all people)
CREATE INDEX idx_kg_nodes_type ON kg_nodes (type);

-- 2. Find nodes by label (case-insensitive prefix/exact match)
CREATE INDEX idx_kg_nodes_label ON kg_nodes (lower(label));

-- 3. Semantic search via pgvector HNSW index.
--    cosine distance (<=>) is used because embedding magnitude varies;
--    cosine normalizes for length, making similarity scores more meaningful.
CREATE INDEX idx_kg_nodes_embedding ON kg_nodes
  USING hnsw (embedding vector_cosine_ops);

-- 4. Find all edges for a given node (both directions)
CREATE INDEX idx_kg_edges_source ON kg_edges (source_node_id);
CREATE INDEX idx_kg_edges_target ON kg_edges (target_node_id);

-- 5. Find edges by type (e.g., all "works_on" relationships)
CREATE INDEX idx_kg_edges_type ON kg_edges (type);

-- 6. Confidence-based queries (find low-confidence facts for review)
CREATE INDEX idx_kg_nodes_confidence ON kg_nodes (confidence) WHERE type = 'fact';
