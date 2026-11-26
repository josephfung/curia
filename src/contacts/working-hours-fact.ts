// working-hours-fact.ts — read a contact's working-hours fact from the knowledge graph.
//
// The fact is a 'fact' node linked to the contact's KG node whose properties.attribute is
// 'working_hours'. Mirrors the assembler's getFacts query. Used by the Setup page (GET
// /api/setup/principal) and by the deep dive's drafting inputs (#2362).

import type { Pool } from 'pg';

/** The newest working-hours value linked to `kgNodeId`, or null when none is recorded. */
export async function readWorkingHoursFact(pool: Pick<Pool, 'query'>, kgNodeId: string): Promise<string | null> {
  const facts = await pool.query<{ value: string | null }>(
    `SELECT n.properties->>'value' AS value
       FROM kg_edges e JOIN kg_nodes n ON n.id = e.target_node_id
      WHERE e.source_node_id = $1 AND e.type = 'relates_to'
        AND n.type = 'fact' AND lower(n.properties->>'attribute') = 'working_hours'
      ORDER BY n.last_confirmed_at DESC LIMIT 1`,
    [kgNodeId],
  );
  return facts.rows[0]?.value ?? null;
}
