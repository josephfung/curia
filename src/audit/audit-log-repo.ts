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

/** A page keyed on audit_log.seq (#2159). seq is a decimal string: BIGINT exceeds JS number precision. */
export interface SeqPage {
  rows: Array<{ seq: string; row: AuditLogRow }>;
  hasMore: boolean;
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
/** How long after an activity window a delegated task is still read as part of it. */
const DELEGATION_TAIL_MS = 6 * 60 * 60 * 1000;
/** Delegation levels read under an activity root before giving up (logged). */
const MAX_DELEGATION_DEPTH = 10;

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
   * Rows for the console activity feed (#2251): the newest root jobs in a
   * window plus everything under them. Newest first, unlike {@link findTimeline}:
   * a capped oldest-first read of a busy day returned the day's first jobs.
   *
   * A root is an agent.task that no other task delegated. Under it come the
   * delegated specialist tasks (linked by `metadata.delegationOrigin.taskEventId`,
   * several levels deep), each task's tool.invoke / agent.response /
   * activity.summary children, and each invoke's tool.result. All lookups but
   * the first use idx_audit_log_parent_event_id.
   *
   * `limit` caps roots. Rows of a root's job that land after `to` are included,
   * so a job that straddles the window edge reads complete. `before` is a keyset
   * cursor: pass the previous page's `nextCursor` to read the next-older roots.
   * Roots use idx_audit_log_activity_roots and delegated tasks
   * idx_audit_log_delegation_origin (migration 105).
   */
  async findActivityJobs(query: {
    from: Date;
    to: Date;
    limit: number;
    before?: { timestamp: Date; id: string };
  }): Promise<{
    roots: AuditLogRow[];
    delegated: AuditLogRow[];
    children: AuditLogRow[];
    hasMore: boolean;
    nextCursor?: { timestamp: Date; id: string };
  }> {
    const limit = Math.min(Math.max(query.limit, 1), MAX_LIMIT);
    const params: unknown[] = [query.from, query.to];
    let cursor = '';
    if (query.before) {
      params.push(query.before.timestamp, query.before.id);
      cursor = `AND (timestamp, id) < ($3, $4::uuid)`;
    }
    params.push(limit + 1);
    // The JSON predicate must match migration 105's index expression exactly.
    const rootResult = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE event_type = 'agent.task'
         AND timestamp >= $1
         AND timestamp < $2
         AND (payload->'metadata'->'delegationOrigin'->>'taskEventId') IS NULL
         ${cursor}
       ORDER BY timestamp DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const allRoots = rootResult.rows.map(mapRow);
    const hasMore = allRoots.length > limit;
    const roots = hasMore ? allRoots.slice(0, limit) : allRoots;
    const oldest = roots[roots.length - 1];
    const nextCursor = hasMore && oldest ? { timestamp: oldest.timestamp, id: oldest.id } : undefined;
    const { delegated, children } = await this.jobRowsUnder(roots, query.to);
    this.logger.debug(
      { roots: roots.length, delegated: delegated.length, children: children.length, hasMore },
      'audit-log-repo: findActivityJobs',
    );
    return { roots, delegated, children, hasMore, nextCursor };
  }

  /**
   * The same rows as {@link findActivityJobs}, for named root agent.task ids
   * (the console's hiccup list, #2350). Roots come back newest first; an id
   * that is not a root agent.task row is skipped. `to` bounds delegated work
   * the same way the window end does there.
   */
  async findActivityJobsByIds(ids: string[], to: Date): Promise<{
    roots: AuditLogRow[];
    delegated: AuditLogRow[];
    children: AuditLogRow[];
  }> {
    if (ids.length === 0) return { roots: [], delegated: [], children: [] };
    const rootResult = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE id = ANY($1::uuid[])
         AND event_type = 'agent.task'
         AND (payload->'metadata'->'delegationOrigin'->>'taskEventId') IS NULL
       ORDER BY timestamp DESC, id DESC`,
      [ids],
    );
    const roots = rootResult.rows.map(mapRow);
    const { delegated, children } = await this.jobRowsUnder(roots, to);
    return { roots, delegated, children };
  }

  /** Delegated tasks, tool calls, replies and summaries under the given roots. */
  private async jobRowsUnder(roots: AuditLogRow[], to: Date): Promise<{ delegated: AuditLogRow[]; children: AuditLogRow[] }> {
    if (roots.length === 0) return { delegated: [], children: [] };

    // Delegated tasks start after their root, so the oldest root bounds the scan
    // from below. Above, the window end plus a margin for jobs still running at it.
    const earliest = roots.reduce((min, r) => (r.timestamp < min ? r.timestamp : min), roots[0]!.timestamp);
    const latest = new Date(to.getTime() + DELEGATION_TAIL_MS);
    const delegated: AuditLogRow[] = [];
    let frontier = roots.map((r) => r.id);
    // Walk until no task delegated further. The bound only guards against a cycle
    // or a runaway chain; reaching it is logged, because the deeper work is then
    // missing from its job.
    let depth = 0;
    for (; depth < MAX_DELEGATION_DEPTH && frontier.length > 0; depth++) {
      const result = await this.pool.query(
        `SELECT ${SELECT_COLUMNS}
         FROM audit_log
         WHERE event_type = 'agent.task'
           AND timestamp >= $1
           AND timestamp < $2
           AND (payload->'metadata'->'delegationOrigin'->>'taskEventId') = ANY($3::text[])`,
        [earliest, latest, frontier],
      );
      const level = result.rows.map(mapRow);
      delegated.push(...level);
      frontier = level.map((r) => r.id);
    }
    if (frontier.length > 0) {
      this.logger.warn(
        { depth, unresolved: frontier.length, maxDepth: MAX_DELEGATION_DEPTH },
        'audit-log-repo: findActivityJobs hit the delegation depth bound; deeper work is left out of its job',
      );
    }

    const taskIds = [...roots, ...delegated].map((r) => r.id);
    const childResult = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE parent_event_id = ANY($1::text[])
         AND event_type = ANY(ARRAY['tool.invoke', 'skill.invoke', 'agent.response', 'activity.summary']::text[])`,
      [taskIds],
    );
    const children = childResult.rows.map(mapRow);
    const invokeIds = children
      .filter((r) => r.eventType === 'tool.invoke' || r.eventType === 'skill.invoke')
      .map((r) => r.id);
    if (invokeIds.length > 0) {
      const resultRows = await this.pool.query(
        `SELECT ${SELECT_COLUMNS}
         FROM audit_log
         WHERE parent_event_id = ANY($1::text[])
           AND event_type = ANY(ARRAY['tool.result', 'skill.result']::text[])`,
        [invokeIds],
      );
      children.push(...resultRows.rows.map(mapRow));
    }
    return { delegated, children };
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
   * Rows of one event type strictly after `afterSeq` (null: from the start), in seq order.
   *
   * seq is the hash-chain key, assigned under a transaction-scoped advisory lock (migration
   * 080, src/audit/logger.ts), so it follows commit order: a row committed later always has
   * a higher seq. That makes it a safe resume cursor where timestamp is not — an event's
   * timestamp is set when it is built, before it waits on the lock (#2159).
   */
  async findByEventTypeAfterSeq(eventType: string, afterSeq: string | null, limit: number): Promise<SeqPage> {
    const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}, seq::text AS seq
       FROM audit_log
       WHERE event_type = $1
         AND ($2::bigint IS NULL OR seq > $2::bigint)
       ORDER BY seq ASC
       LIMIT $3`,
      [eventType, afterSeq, capped + 1],
    );
    const hasMore = result.rows.length > capped;
    const rows = (hasMore ? result.rows.slice(0, capped) : result.rows).map((r: Record<string, unknown>) => ({
      seq: String(r.seq),
      row: mapRow(r),
    }));
    return { rows, hasMore };
  }

  /** True when a row of `eventType` has exactly this seq — lets a cursor be checked as real. */
  async hasEventAtSeq(eventType: string, seq: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT true AS exists FROM audit_log WHERE event_type = $1 AND seq = $2::bigint LIMIT 1`,
      [eventType, seq],
    );
    return result.rows.length > 0;
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
   * The tool results of the given agent turns, newest first (#2159: the band brief's evidence).
   * A tool.result is the child of its tool.invoke, which is the child of the agent.task
   * (runtime.ts), so this walks two levels. Both levels use idx_audit_log_parent_event_id.
   * Newest first so the limit keeps the lookups closest to the send.
   */
  async findToolResultsForTasks(taskEventIds: readonly string[], limit: number): Promise<AuditLogRow[]> {
    if (taskEventIds.length === 0) return [];
    const clamped = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE event_type = ANY(ARRAY['tool.result', 'skill.result']::text[])
         AND parent_event_id IN (
           SELECT id::text FROM audit_log
           WHERE parent_event_id = ANY($1::text[])
             AND event_type = ANY(ARRAY['tool.invoke', 'skill.invoke']::text[])
         )
       ORDER BY timestamp DESC, id DESC
       LIMIT $2`,
      [[...taskEventIds], clamped],
    );
    return result.rows.map(mapRow);
  }

  /**
   * What the given agent turns reported to the principal, newest first (#2312). The
   * report-to-principal tool files a principal.report under the drafting turn's agent.task,
   * so one level, on idx_audit_log_parent_event_id. Evidence for the band brief: a send that
   * says "I've passed that to <principal>" is supported by one. Only the agent's own reports:
   * system-generated ones such as relay_deferred embed the held draft verbatim and say nothing
   * the assistant told the principal. The dispatcher's relay note is parented on the
   * agent.response, not the task, so it never matches here; it reaches the review as the
   * send's `reportedToPrincipal` instead.
   */
  async findPrincipalReportsForTasks(taskEventIds: readonly string[], limit: number): Promise<AuditLogRow[]> {
    if (taskEventIds.length === 0) return [];
    const clamped = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE event_type = 'principal.report'
         AND parent_event_id = ANY($1::text[])
         AND payload->>'source' = 'agent'
       ORDER BY timestamp DESC, id DESC
       LIMIT $2`,
      [[...taskEventIds], clamped],
    );
    return result.rows.map(mapRow);
  }

  /**
   * The inbound messages a turn lane drained into a running task (#2499), as their
   * `inbound.message` event ids, newest first. The runtime audits each drain as an
   * `agent.task.input_injected` row naming the host task and the inbound, on the host's
   * conversation, so the lookup rides idx_audit_conversation. Evidence for the band brief: a
   * follow-up that joined the turn is part of what the sender asked for.
   */
  async findInjectedInboundIds(conversationId: string, hostTaskEventId: string, limit: number): Promise<string[]> {
    const clamped = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const result = await this.pool.query<{ inbound_event_id: string | null }>(
      `SELECT payload->>'inboundEventId' AS inbound_event_id
       FROM audit_log
       WHERE conversation_id = $1
         AND event_type = 'agent.task.input_injected'
         AND payload->>'hostTaskEventId' = $2
       ORDER BY timestamp DESC, id DESC
       LIMIT $3`,
      [conversationId, hostTaskEventId, clamped],
    );
    return result.rows
      .map((r) => r.inbound_event_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  /**
   * One sender's latest inbound messages on a conversation before `before`, newest first
   * (#2499). `senderId` is the channel's sender id as the inbound carried it (the dispatcher
   * copies the same value onto the coordinator's agent.task), compared without case: an email
   * address in another case is the same sender. Scoped to the conversation (its
   * (conversation_id, timestamp) index) and bounded by `limit`. Evidence for the band brief: a push in an earlier message is part of
   * what the sender asked for, even when the message that started the work is bland.
   *
   * Messages stamped the same millisecond as `before` are included (ids are random, so they
   * cannot be ordered against it): the caller names the ones it already has in `excludeIds`.
   * Rows without string content and excluded ids are dropped before the limit applies.
   */
  async findRecentInboundsFromSender(
    conversationId: string,
    senderId: string,
    before: Date,
    limit: number,
    excludeIds: readonly string[] = [],
  ): Promise<AuditLogRow[]> {
    const clamped = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE conversation_id = $1
         AND event_type = 'inbound.message'
         AND lower(payload->>'senderId') = lower($2)
         AND timestamp <= $3
         AND jsonb_typeof(payload->'content') = 'string'
         AND id <> ALL($5::text[])
       ORDER BY timestamp DESC, id DESC
       LIMIT $4`,
      [conversationId, senderId, before, clamped, [...excludeIds]],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Requester-identity evidence rendered into one delegated specialist task (#1859).
   * `delegateEventId` is that task's `agent.task` id. Matches the structured
   * `target_id` and, if extraction failed, `payload.delegateEventId`.
   * Oldest first. A single run writes one row; a replay of the same task writes another.
   */
  async findDelegationRequesterContext(
    delegateEventId: string,
    options: { limit?: number } = {},
  ): Promise<AuditLogRow[]> {
    if (delegateEventId.length === 0) return [];
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM audit_log
       WHERE event_type = 'delegation.requester_context'
         AND (
           (target_type = 'delegation' AND target_id = $1)
           OR payload->>'delegateEventId' = $1
         )
       ORDER BY timestamp ASC, id ASC
       LIMIT $2`,
      [delegateEventId, limit],
    );
    const rows = result.rows.map(mapRow);
    this.logger.debug(
      { count: rows.length, delegateEventId },
      'audit-log-repo: findDelegationRequesterContext',
    );
    return rows;
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
