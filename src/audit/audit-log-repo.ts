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

export interface TimelineAuditQuery {
  from?: Date;
  to?: Date;
  conversationId?: string;
  taskId?: string;
  limit?: number;
  /**
   * Keyset cursor — fetch rows strictly after this (timestamp, id) pair.
   * Timestamps are compared at millisecond precision: all current audit writers
   * insert ms-aligned `Date` values. Sub-ms rows (e.g. from `now()` default on
   * a raw INSERT) could duplicate or skip at page boundaries until write-side
   * truncation is enforced.
   */
  after?: { timestamp: Date; id: string };
}

/** Same filter shape as {@link TimelineAuditQuery}. */
export type EventTypesAuditQuery = TimelineAuditQuery;

export interface TimelinePage {
  rows: AuditLogRow[];
  hasMore: boolean;
  /** Set when {@link TimelinePage.hasMore} is true — pass as `after` for the next page. */
  nextCursor?: { timestamp: Date; id: string };
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function assertTimelineScope(query: TimelineAuditQuery): void {
  if (!query.from && !query.to && !query.conversationId && !query.taskId) {
    throw new Error(
      'findTimeline requires at least one scope filter: from, to, conversationId, or taskId',
    );
  }
}

/** Uses idx_audit_log_payload_task_id — expression must match the migration exactly. */
function payloadTaskIdCondition(paramIndex: number): string {
  return `payload->>'taskId' = $${paramIndex}`;
}

function applyTimelineFilters(
  query: TimelineAuditQuery,
  params: unknown[],
  conditions: string[],
): void {
  if (query.from) {
    params.push(query.from);
    conditions.push(`timestamp >= $${params.length}`);
  }
  if (query.to) {
    params.push(query.to);
    conditions.push(`timestamp < $${params.length}`);
  }
  if (query.conversationId) {
    params.push(query.conversationId);
    conditions.push(`conversation_id = $${params.length}`);
  }
  if (query.taskId) {
    params.push(query.taskId);
    conditions.push(payloadTaskIdCondition(params.length));
  }
  if (query.after) {
    params.push(query.after.timestamp);
    const tsParam = params.length;
    params.push(query.after.id);
    conditions.push(`(timestamp, id) > ($${tsParam}, $${params.length})`);
  }
}

function pageFromRows(mapped: AuditLogRow[], limit: number): TimelinePage {
  const hasMore = mapped.length > limit;
  const rows = hasMore ? mapped.slice(0, limit) : mapped;
  const last = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    nextCursor: hasMore && last !== undefined
      ? { timestamp: last.timestamp, id: last.id }
      : undefined,
  };
}

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

  /**
   * Return audit rows in a time window, optionally filtered by conversation or task.
   * Requires at least one scope filter. Returns a page with {@link TimelinePage.hasMore}
   * so callers know when the cap truncated results; use {@link TimelineAuditQuery.after}
   * for keyset pagination on `(timestamp, id)`.
   */
  async findTimeline(query: TimelineAuditQuery): Promise<TimelinePage> {
    assertTimelineScope(query);
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const params: unknown[] = [];
    const conditions: string[] = [];

    applyTimelineFilters(query, params, conditions);

    params.push(limit + 1);
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await this.pool.query(
      `SELECT id, timestamp, event_type, source_layer, source_id,
              conversation_id, parent_event_id, payload
       FROM audit_log
       ${whereClause}
       ORDER BY timestamp ASC, id ASC
       LIMIT $${params.length}`,
      params,
    );

    const page = pageFromRows(result.rows.map(mapRow), limit);

    this.logger.debug(
      { count: page.rows.length, hasMore: page.hasMore, from: query.from, to: query.to },
      'audit-log-repo: findTimeline',
    );

    return page;
  }

  /**
   * Return audit rows matching any of the given event types within an optional window.
   * Same pagination contract as {@link findTimeline}; scoped by the event-type list.
   */
  async findByEventTypes(
    eventTypes: string[],
    query: EventTypesAuditQuery = {},
  ): Promise<TimelinePage> {
    if (eventTypes.length === 0) {
      return { rows: [], hasMore: false };
    }

    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const params: unknown[] = [eventTypes];
    const conditions: string[] = [`event_type = ANY($1::text[])`];

    applyTimelineFilters(query, params, conditions);

    params.push(limit + 1);

    const result = await this.pool.query(
      `SELECT id, timestamp, event_type, source_layer, source_id,
              conversation_id, parent_event_id, payload
       FROM audit_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY timestamp ASC, id ASC
       LIMIT $${params.length}`,
      params,
    );

    const page = pageFromRows(result.rows.map(mapRow), limit);

    this.logger.debug(
      { count: page.rows.length, hasMore: page.hasMore, eventTypes },
      'audit-log-repo: findByEventTypes',
    );
    return page;
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
