-- Up Migration

-- Ensure at most one agent KG node (is_agent = true) and one agent contact
-- exist, so bootstrapAgentIdentity() is truly idempotent across concurrent
-- startup processes.
--
-- Without these constraints, ON CONFLICT DO NOTHING in the bootstrap INSERT
-- has nothing to conflict on (UUID PKs are always unique), and two concurrent
-- startups would silently create two agent records.

-- Partial unique index on kg_nodes for the agent singleton.
-- Only one row with properties->>'is_agent' = 'true' may exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_nodes_agent_singleton
  ON kg_nodes ((properties->>'is_agent'))
  WHERE (properties->>'is_agent') = 'true';

-- Partial unique index on contacts: at most one contact per kg_node_id.
-- This also guarantees the agent's contact record is a singleton once the
-- KG node is a singleton.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_kg_node_unique
  ON contacts (kg_node_id)
  WHERE kg_node_id IS NOT NULL;
