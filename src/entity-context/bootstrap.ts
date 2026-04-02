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
 * Idempotent: safe to call on every startup. Uses SELECT + INSERT ... ON CONFLICT
 * to avoid race conditions between concurrent startup attempts.
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
  // Using SELECT first, then INSERT ... ON CONFLICT, so we never overwrite an
  // existing record even if two processes start simultaneously.
  const existingNodeResult = await pool.query<{ id: string }>(
    `SELECT id FROM kg_nodes
     WHERE type = 'person'
       AND (properties->>'is_agent')::boolean = true
     LIMIT 1`,
    [],
  );

  let kgNodeId: string;

  if (existingNodeResult.rows.length > 0) {
    kgNodeId = existingNodeResult.rows[0]!.id;
    logger.debug({ kgNodeId }, 'agent-bootstrap: found existing agent KG node');
  } else {
    // Insert a new 'person' node for the agent.
    // Confidence 1.0 + permanent decay: the agent's identity doesn't change.
    const insertNodeResult = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at)
       VALUES ('person', $1, $2, 1.0, 'permanent', 'bootstrap', now(), now())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        displayName,
        JSON.stringify({ is_agent: true }),
      ],
    );

    if (insertNodeResult.rows.length > 0) {
      kgNodeId = insertNodeResult.rows[0]!.id;
      logger.info({ kgNodeId, displayName }, 'agent-bootstrap: created agent KG node');
    } else {
      // ON CONFLICT fired — another process got there first. Re-read.
      const retryResult = await pool.query<{ id: string }>(
        `SELECT id FROM kg_nodes
         WHERE type = 'person'
           AND (properties->>'is_agent')::boolean = true
         LIMIT 1`,
        [],
      );
      if (!retryResult.rows[0]) {
        throw new Error('agent-bootstrap: failed to find or create agent KG node');
      }
      kgNodeId = retryResult.rows[0].id;
    }
  }

  // Step 2: Find or create the agent's contact record linked to the KG node.
  const existingContactResult = await pool.query<{ id: string }>(
    'SELECT id FROM contacts WHERE kg_node_id = $1 LIMIT 1',
    [kgNodeId],
  );

  let contactId: string;

  if (existingContactResult.rows.length > 0) {
    contactId = existingContactResult.rows[0]!.id;
    logger.debug({ contactId, kgNodeId }, 'agent-bootstrap: found existing agent contact');
  } else {
    // Insert the contact record.
    // Status 'confirmed' — the agent is always confirmed.
    // role 'agent' — distinguishes it from human CEO/staff contacts.
    const insertContactResult = await pool.query<{ id: string }>(
      `INSERT INTO contacts (kg_node_id, display_name, role, status, created_at, updated_at)
       VALUES ($1, $2, 'agent', 'confirmed', now(), now())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [kgNodeId, displayName],
    );

    if (insertContactResult.rows.length > 0) {
      contactId = insertContactResult.rows[0]!.id;
      logger.info({ contactId, kgNodeId, displayName }, 'agent-bootstrap: created agent contact record');
    } else {
      // ON CONFLICT fired — re-read.
      const retryResult = await pool.query<{ id: string }>(
        'SELECT id FROM contacts WHERE kg_node_id = $1 LIMIT 1',
        [kgNodeId],
      );
      if (!retryResult.rows[0]) {
        throw new Error('agent-bootstrap: failed to find or create agent contact record');
      }
      contactId = retryResult.rows[0].id;
    }
  }

  return { kgNodeId, contactId };
}
