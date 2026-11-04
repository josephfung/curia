// learned-describer-repo.ts — reads and writes activity_describers (#2455, ADR-059).
//
// The table is small (one row per agent and undescribed tool), so the feed reads
// it whole on each request rather than caching it.

import type { Pool } from 'pg';
import type { DescriberSource, LearnedDescriber, ToolEffect } from './learned-describers.js';

interface DescriberRow {
  agent_id: string;
  tool_name: string;
  effect: ToolEffect;
  verb: string;
  one: string;
  many: string;
  attempt: string;
  description_hash: string;
  source: DescriberSource;
}

function fromRow(row: DescriberRow): LearnedDescriber {
  return {
    agentId: row.agent_id,
    toolName: row.tool_name,
    effect: row.effect,
    verb: row.verb,
    one: row.one,
    many: row.many,
    attempt: row.attempt,
    descriptionHash: row.description_hash,
    source: row.source,
  };
}

const COLUMNS = 'agent_id, tool_name, effect, verb, one, many, attempt, description_hash, source';

export class LearnedDescriberRepo {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async list(): Promise<LearnedDescriber[]> {
    const result = await this.pool.query<DescriberRow>(`SELECT ${COLUMNS} FROM activity_describers`);
    return result.rows.map(fromRow);
  }

  async get(agentId: string, toolName: string): Promise<LearnedDescriber | null> {
    const result = await this.pool.query<DescriberRow>(
      `SELECT ${COLUMNS} FROM activity_describers WHERE agent_id = $1 AND tool_name = $2`,
      [agentId, toolName],
    );
    const row = result.rows[0];
    return row ? fromRow(row) : null;
  }

  /**
   * Insert or replace a learned row. An operator row is left alone, whatever
   * the caller checked first, so a hand edit survives a race with the learner.
   * Returns false when an operator row kept its place.
   */
  async upsert(describer: Omit<LearnedDescriber, 'source'> & { source: Exclude<DescriberSource, 'operator'> }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO activity_describers (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (agent_id, tool_name) DO UPDATE SET
         effect = EXCLUDED.effect,
         verb = EXCLUDED.verb,
         one = EXCLUDED.one,
         many = EXCLUDED.many,
         attempt = EXCLUDED.attempt,
         description_hash = EXCLUDED.description_hash,
         source = EXCLUDED.source,
         updated_at = now()
       WHERE activity_describers.source <> 'operator'`,
      [
        describer.agentId,
        describer.toolName,
        describer.effect,
        describer.verb,
        describer.one,
        describer.many,
        describer.attempt,
        describer.descriptionHash,
        describer.source,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
