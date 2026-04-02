// src/entity-context/bootstrap.ts
//
// Agent self-identity bootstrap.
//
// Nathan Curia (the agent) is an entity like any other person — it has a KG node,
// a contact record, and connected accounts. This lets "your calendar" resolve the
// same way as "Jenna's calendar" through the entity-context system.
//
// This module is called once at startup. It is idempotent: if the agent's KG node
// and contact record already exist, it verifies them and returns the existing IDs
// without creating duplicates.
//
// Idempotency is guaranteed by two partial unique indexes added in migration 010:
//   - idx_kg_nodes_agent_singleton on (properties->>'is_agent') WHERE = 'true'
//   - idx_contacts_kg_node_unique on (kg_node_id) WHERE kg_node_id IS NOT NULL
//
// The returned contactId is injected into:
//   - The coordinator's system prompt (so "you" resolves correctly)
//   - The ExecutionLayer (for entity_enrichment default='agent')

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

export interface AgentIdentity {
  kgNodeId: string;
  contactId: string;
}

/**
 * Ensure Nathan's KG node and contact record exist, returning their IDs.
 *
 * Idempotent: safe to call on every startup. The INSERT ... ON CONFLICT targets
 * the partial unique indexes from migration 010 so concurrent startups
 * cannot create duplicate agent records.
 *
 * @param displayName  The agent's display name (from persona config)
 * @param pool         Postgres connection pool
 * @param logger       Pino logger
 */
export async function bootstrapAgentIdentity(
  displayName: string,
  pool: DbPool,
  logger: Logger,
): Promise<AgentIdentity> {
  // Step 1: Find or create the agent's KG node.
  // We identify the agent by a special property: is_agent = true.
  // The partial unique index idx_kg_nodes_agent_singleton (migration 010) ensures
  // ON CONFLICT fires when a concurrent INSERT tries to create a second agent node.
  try {
    const nodeResult = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at)
       VALUES ('person', $1, $2, 1.0, 'permanent', 'bootstrap', now(), now())
       ON CONFLICT ((properties->>'is_agent')) WHERE (properties->>'is_agent') = 'true'
       DO UPDATE SET label = EXCLUDED.label, last_confirmed_at = now()
       RETURNING id`,
      [
        displayName,
        JSON.stringify({ is_agent: true }),
      ],
    );

    if (!nodeResult.rows[0]) {
      throw new Error(
        `agent-bootstrap: INSERT ... ON CONFLICT returned no rows for displayName="${displayName}" — ` +
        'check that migration 010 was applied (idx_kg_nodes_agent_singleton must exist)',
      );
    }
    const kgNodeId = nodeResult.rows[0].id;
    logger.debug({ kgNodeId, displayName }, 'agent-bootstrap: agent KG node ready');

    // Step 2: Find or create the agent's contact record linked to the KG node.
    // The partial unique index idx_contacts_kg_node_unique (migration 010) ensures
    // ON CONFLICT fires when a concurrent INSERT tries to create a second contact for
    // the same KG node.
    const contactResult = await pool.query<{ id: string }>(
      `INSERT INTO contacts (kg_node_id, display_name, role, status, created_at, updated_at)
       VALUES ($1, $2, 'agent', 'confirmed', now(), now())
       ON CONFLICT (kg_node_id) WHERE kg_node_id IS NOT NULL
       DO UPDATE SET role = 'agent', updated_at = now()
       RETURNING id`,
      [kgNodeId, displayName],
    );

    if (!contactResult.rows[0]) {
      throw new Error(
        `agent-bootstrap: INSERT ... ON CONFLICT returned no rows for kgNodeId="${kgNodeId}" — ` +
        'check that migration 010 was applied (idx_contacts_kg_node_unique must exist)',
      );
    }
    const contactId = contactResult.rows[0].id;
    logger.info({ contactId, kgNodeId, displayName }, 'agent-bootstrap: agent identity ready');

    return { kgNodeId, contactId };
  } catch (err) {
    logger.error({ err, displayName }, 'agent-bootstrap: failed to bootstrap agent identity');
    throw err;
  }
}
