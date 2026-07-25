// audit-log-repo.ts — read-only queries against the append-only audit_log table.
//
// Skills must not access the pool directly; this repo is the sanctioned read path.
// Phase 1 (#1383): exposes structured columns and filter dimensions; historical
// rows have NULL columns and readers must fall back to payload.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import { expandLegacyToolEventTypes } from './legacy-tool-events.js';

export interface AuditLogRow {
  id: string;
  timestamp: Date;
  eventType: string;
  sourceLayer: string;
  sourceId: string;
  conversationId: string | null;
  /** Populated when the writer set the task_id column; null on legacy rows. */
  taskId: string | null;
  parentEventId: string | null;
  payload: Record<string, unknown>;
  /** Structured columns — null on pre-hardening rows (migration 078). */
  action: string | null;
  outcome: string | null;
  targetType: string | null;
  targetId: string | null;
  initiatorType: string | null;
  initiatorId: string | null;
  entryHash: string | null;
}

export interface ToolResultAuditQuery {
  since: Date;
  until: Date;
  toolNames?: string[];
  agentId?: string;
  limit?: number;
}

export interface TimelineAuditQuery {
  from?: Date;
  to?: Date;
  conversationId?: string;
  taskId?: string;
  outcome?: string;
  targetType?: string;
  targetId?: string;
  initiatorType?: string;
  initiatorId?: string;
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

/** Columns selected by every read path — keep in sync with {@link mapRow}. */
const SELECT_COLUMNS = `id, timestamp, event_type, source_layer, source_id,
              conversation_id, task_id, parent_event_id, payload,
              action, outcome, target_type, target_id,
              initiator_type, initiator_id, entry_hash`;

function assertTimelineScope(query: TimelineAuditQuery): void {
  if (
    !query.from && !query.to && !query.conversationId && !query.taskId
    && !query.outcome && !query.targetType && !query.targetId
    && !query.initiatorType && !query.initiatorId
  ) {
    throw new Error(
      'findTimeline requires at least one scope filter: from, to, conversationId, taskId, outcome, targetType/targetId, or initiatorType/initiatorId',
    );
  }
}

/**
 * Match task_id column when populated; fall back to payload->>'taskId' for
 * legacy rows that never got the column filled (index 071 still covers those).
 */
function taskIdCondition(paramIndex: number): string {
  return `(task_id = $${paramIndex} OR (task_id IS NULL AND payload->>'taskId' = $${paramIndex}))`;
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
    conditions.push(taskIdCondition(params.length));
  }
  if (query.outcome) {
    params.push(query.outcome);
    conditions.push(`outcome = $${params.length}`);
  }
  if (query.targetType) {
    params.push(query.targetType);
    conditions.push(`target_type = $${params.length}`);
  }
  if (query.targetId) {
    params.push(query.targetId);
    conditions.push(`target_id = $${params.length}`);
  }
  if (query.initiatorType) {
    params.push(query.initiatorType);
    conditions.push(`initiator_type = $${params.length}`);
  }
  if (query.initiatorId) {
    params.push(query.initiatorId);
    conditions.push(`initiator_id = $${params.length}`);
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
   * Return tool-result audit rows in a half-open [since, until) window.
   * Matches both current `tool.result` and pre-ADR-031 `skill.result` rows
   * (and `toolName` / `skillName` payload fields) so activity-log and diagnostics
   * keep seeing pre-upgrade history.
   * Optional filters narrow by tool name(s) and executing agent id.
   */
  async findToolResults(query: ToolResultAuditQuery): Promise<AuditLogRow[]> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const params: unknown[] = [query.since, query.until];
    let skillFilter = '';
    if (query.toolNames && query.toolNames.length > 0) {
      params.push(query.toolNames);
      // Prefer structured target_id (Phase 1); fall back to payload dual vocabulary.
      skillFilter = `AND (
        (target_type = 'skill' AND target_id = ANY($${params.length}::text[]))
        OR (target_id IS NULL AND COALESCE(payload->>'toolName', payload->>'skillName') = ANY($${params.length}::text[]))
      )`;
    }
    let agentFilter = '';
    if (query.agentId) {
      params.push(query.agentId);
      agentFilter = `AND source_id = $${params.length}`;
    }
    params.push(limit);

    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE timestamp >= $1
         AND timestamp < $2
         AND event_type = ANY(ARRAY['tool.result', 'skill.result']::text[])
         ${skillFilter}
         ${agentFilter}
       ORDER BY timestamp ASC
       LIMIT $${params.length}`,
      params,
    );

    const rows = result.rows.map(mapRow);
    this.logger.debug(
      { count: rows.length, since: query.since, until: query.until },
      'audit-log-repo: findToolResults',
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
      `SELECT ${SELECT_COLUMNS}
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
    // Dual-match tool.* ↔ skill.* so diagnostics audit-query keeps pre-upgrade rows.
    const expandedTypes = expandLegacyToolEventTypes(eventTypes);
    const params: unknown[] = [expandedTypes];
    const conditions: string[] = [`event_type = ANY($1::text[])`];

    applyTimelineFilters(query, params, conditions);

    params.push(limit + 1);

    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY timestamp ASC, id ASC
       LIMIT $${params.length}`,
      params,
    );

    const page = pageFromRows(result.rows.map(mapRow), limit);

    this.logger.debug(
      { count: page.rows.length, hasMore: page.hasMore, eventTypes, expandedTypes },
      'audit-log-repo: findByEventTypes',
    );
    return page;
  }

  /**
   * Fetch a single audit row by its event id. Returns null when no row matches.
   * Used by the diagnostics agent to anchor a causal-chain trace on one event.
   */
  async findById(id: string): Promise<AuditLogRow | null> {
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Return the direct children of an event — rows whose `parent_event_id` matches.
   * Ordered oldest-first for deterministic chain assembly. Bounded by `limit`
   * (default {@link DEFAULT_LIMIT}, capped at {@link MAX_LIMIT}); the returned count
   * reaching the limit is the caller's signal that the fan-out was truncated.
   */
  async findChildren(parentEventId: string, options: { limit?: number } = {}): Promise<AuditLogRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE parent_event_id = $1
       ORDER BY timestamp ASC, id ASC
       LIMIT $2`,
      [parentEventId, limit],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Return audit rows whose payload carries the given `blockId` (e.g. an
   * `outbound.blocked` event and anything that references it). Optional [from, to)
   * window narrows the scan. Backed by idx_audit_log_payload_block_id (migration 072).
   */
  async findByBlockId(
    blockId: string,
    query: { from?: Date; to?: Date; limit?: number } = {},
  ): Promise<AuditLogRow[]> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const params: unknown[] = [blockId];
    const conditions: string[] = [`payload->>'blockId' = $1`];
    if (query.from) {
      params.push(query.from);
      conditions.push(`timestamp >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`timestamp < $${params.length}`);
    }
    params.push(limit);

    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY timestamp ASC, id ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapRow);
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
    taskId: (row.task_id as string | null) ?? null,
    parentEventId: (row.parent_event_id as string | null) ?? null,
    payload: typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {},
    action: (row.action as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    targetType: (row.target_type as string | null) ?? null,
    targetId: (row.target_id as string | null) ?? null,
    initiatorType: (row.initiator_type as string | null) ?? null,
    initiatorId: (row.initiator_id as string | null) ?? null,
    entryHash: (row.entry_hash as string | null) ?? null,
  };
}
