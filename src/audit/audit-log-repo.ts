// audit-log-repo.ts — read-only queries against the append-only audit_log table.
//
// Skills must not access the pool directly; this repo is the sanctioned read path.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

export interface AuditLogRow {
  id: string;
  timestamp: Date;
  eventType: string;
  sourceLayer: string;
  sourceId: string;
  conversationId: string | null;
  parentEventId: string | null;
  payload: Record<string, unknown>;
}

export interface SkillResultAuditQuery {
  since: Date;
  until: Date;
  skillNames?: string[];
  agentId?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class AuditLogRepo {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /**
   * Return `skill.result` audit rows in a half-open [since, until) window.
   * Optional filters narrow by skill name(s) and executing agent id.
   */
  async findSkillResults(query: SkillResultAuditQuery): Promise<AuditLogRow[]> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const params: unknown[] = [query.since, query.until];
    let skillFilter = '';
    if (query.skillNames && query.skillNames.length > 0) {
      params.push(query.skillNames);
      skillFilter = `AND payload->>'skillName' = ANY($${params.length}::text[])`;
    }
    let agentFilter = '';
    if (query.agentId) {
      params.push(query.agentId);
      agentFilter = `AND source_id = $${params.length}`;
    }
    params.push(limit);

    const result = await this.pool.query(
      `SELECT id, timestamp, event_type, source_layer, source_id,
              conversation_id, parent_event_id, payload
       FROM audit_log
       WHERE timestamp >= $1
         AND timestamp < $2
         AND event_type = 'skill.result'
         ${skillFilter}
         ${agentFilter}
       ORDER BY timestamp ASC
       LIMIT $${params.length}`,
      params,
    );

    const rows = result.rows.map(mapRow);
    this.logger.debug(
      { count: rows.length, since: query.since, until: query.until },
      'audit-log-repo: findSkillResults',
    );
    return rows;
  }
}

function mapRow(row: Record<string, unknown>): AuditLogRow {
  const payload = row.payload;
  return {
    id: row.id as string,
    timestamp: new Date(row.timestamp as string),
    eventType: row.event_type as string,
    sourceLayer: row.source_layer as string,
    sourceId: row.source_id as string,
    conversationId: (row.conversation_id as string | null) ?? null,
    parentEventId: (row.parent_event_id as string | null) ?? null,
    payload: typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {},
  };
}
