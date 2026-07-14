// diagnostics-repo.ts — read-only access to the operational + agent-state tables
// for the diagnostics agent (#1356).
//
// This is a deliberately narrow, single-purpose read surface: one file, only
// parameterized SELECTs, no writes. It reads the tables that explain the "why"
// behind an incident — scheduled_jobs, held_messages, autonomy_action_log,
// outbound_context, working_memory — scoped by the diagnostic filters an
// investigator anchors on (an id, a conversation, a task, an agent, a window).
//
// Rows are returned RAW; the ops-lookup handler applies redaction/summarization
// (src/diagnostics/redact.ts) before anything leaves the skill. Keeping redaction
// in the handler mirrors AuditLogRepo (which also returns raw payloads) and keeps
// this repo a pure data-access layer.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Superset of diagnostic filters; each method reads the subset it supports. */
export interface DiagnosticsQuery {
  id?: string;
  conversationId?: string;
  taskId?: string;
  agentId?: string;
  status?: string;
  skillName?: string;
  outcome?: string;
  role?: string;
  /** Half-open [from, to) window applied to created_at. */
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface ScheduledJobRow {
  id: string;
  agentId: string;
  sourceAgentId: string | null;
  taskId: string | null;
  cronExpr: string | null;
  runAt: Date | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  runStartedAt: Date | null;
  status: string;
  lastRunOutcome: string | null;
  lastRunSummary: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: Date;
  taskPayload: Record<string, unknown>;
}

export interface HeldMessageRow {
  id: string;
  channel: string;
  senderId: string;
  conversationId: string | null;
  subject: string | null;
  content: string;
  status: string;
  metadata: Record<string, unknown>;
  resolvedContactId: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface ActionLogEntryRow {
  id: string;
  taskId: string;
  conversationId: string | null;
  skillName: string;
  actionRisk: string;
  outcome: string;
  taskSummary: string | null;
  description: string | null;
  shortRef: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  payload: Record<string, unknown>;
}

export interface OutboundContextRow {
  id: string;
  conversationId: string;
  channelId: string;
  agentId: string;
  contentPreview: string;
  expectedReply: string | null;
  delegationHint: string | null;
  metadata: Record<string, unknown>;
  released: boolean;
  /** True when expires_at is in the past — the entry is stale but not yet swept. */
  expired: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export interface WorkingMemoryRow {
  id: string;
  conversationId: string;
  agentId: string;
  role: string;
  content: string;
  archived: boolean;
  createdAt: Date;
  expiresAt: Date | null;
}

function clampLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/** Append a created_at [from, to) window to a growing conditions/params pair. */
function applyWindow(query: DiagnosticsQuery, params: unknown[], conditions: string[]): void {
  if (query.from) {
    params.push(query.from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (query.to) {
    params.push(query.to);
    conditions.push(`created_at < $${params.length}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string);
}

export class DiagnosticsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async getScheduledJobs(query: DiagnosticsQuery): Promise<ScheduledJobRow[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (query.id) {
      params.push(query.id);
      conditions.push(`id = $${params.length}`);
    }
    if (query.taskId) {
      params.push(query.taskId);
      conditions.push(`task_id = $${params.length}`);
    }
    if (query.agentId) {
      params.push(query.agentId);
      conditions.push(`agent_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    applyWindow(query, params, conditions);
    params.push(clampLimit(query.limit));

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT id, agent_id, source_agent_id, task_id, cron_expr, run_at, next_run_at,
              last_run_at, run_started_at, status, last_run_outcome, last_run_summary,
              last_error, consecutive_failures, created_by, created_at, task_payload
       FROM scheduled_jobs
       ${where}
       ORDER BY created_at ASC
       LIMIT $${params.length}`,
      params,
    );
    this.logger.debug({ count: result.rows.length }, 'diagnostics-repo: getScheduledJobs');
    return result.rows.map((r) => ({
      id: r.id as string,
      agentId: r.agent_id as string,
      sourceAgentId: (r.source_agent_id as string | null) ?? null,
      taskId: (r.task_id as string | null) ?? null,
      cronExpr: (r.cron_expr as string | null) ?? null,
      runAt: asDate(r.run_at),
      nextRunAt: asDate(r.next_run_at),
      lastRunAt: asDate(r.last_run_at),
      runStartedAt: asDate(r.run_started_at),
      status: r.status as string,
      lastRunOutcome: (r.last_run_outcome as string | null) ?? null,
      lastRunSummary: (r.last_run_summary as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      consecutiveFailures: Number(r.consecutive_failures ?? 0),
      createdBy: r.created_by as string,
      createdAt: new Date(r.created_at as string),
      taskPayload: asRecord(r.task_payload),
    }));
  }

  async getHeldMessages(query: DiagnosticsQuery): Promise<HeldMessageRow[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (query.id) {
      params.push(query.id);
      conditions.push(`id = $${params.length}`);
    }
    if (query.conversationId) {
      params.push(query.conversationId);
      conditions.push(`conversation_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    applyWindow(query, params, conditions);
    params.push(clampLimit(query.limit));

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT id, channel, sender_id, conversation_id, subject, content, status,
              metadata, resolved_contact_id, created_at, processed_at
       FROM held_messages
       ${where}
       ORDER BY created_at ASC
       LIMIT $${params.length}`,
      params,
    );
    this.logger.debug({ count: result.rows.length }, 'diagnostics-repo: getHeldMessages');
    return result.rows.map((r) => ({
      id: r.id as string,
      channel: r.channel as string,
      senderId: r.sender_id as string,
      conversationId: (r.conversation_id as string | null) ?? null,
      subject: (r.subject as string | null) ?? null,
      content: r.content as string,
      status: r.status as string,
      metadata: asRecord(r.metadata),
      resolvedContactId: (r.resolved_contact_id as string | null) ?? null,
      createdAt: new Date(r.created_at as string),
      processedAt: asDate(r.processed_at),
    }));
  }

  async getActionLog(query: DiagnosticsQuery): Promise<ActionLogEntryRow[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (query.id) {
      params.push(query.id);
      conditions.push(`id::text = $${params.length}`);
    }
    if (query.taskId) {
      params.push(query.taskId);
      conditions.push(`task_id = $${params.length}`);
    }
    if (query.conversationId) {
      params.push(query.conversationId);
      conditions.push(`conversation_id = $${params.length}`);
    }
    if (query.skillName) {
      params.push(query.skillName);
      conditions.push(`skill_name = $${params.length}`);
    }
    if (query.outcome) {
      params.push(query.outcome);
      conditions.push(`outcome = $${params.length}`);
    }
    applyWindow(query, params, conditions);
    params.push(clampLimit(query.limit));

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT id, task_id, conversation_id, skill_name, action_risk, outcome,
              task_summary, description, short_ref, resolved_by, resolved_at,
              expires_at, created_at, payload
       FROM autonomy_action_log
       ${where}
       ORDER BY created_at ASC
       LIMIT $${params.length}`,
      params,
    );
    this.logger.debug({ count: result.rows.length }, 'diagnostics-repo: getActionLog');
    return result.rows.map((r) => ({
      id: String(r.id),
      taskId: r.task_id as string,
      conversationId: (r.conversation_id as string | null) ?? null,
      skillName: r.skill_name as string,
      actionRisk: r.action_risk as string,
      outcome: r.outcome as string,
      taskSummary: (r.task_summary as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      shortRef: (r.short_ref as string | null) ?? null,
      resolvedBy: (r.resolved_by as string | null) ?? null,
      resolvedAt: asDate(r.resolved_at),
      expiresAt: asDate(r.expires_at),
      createdAt: new Date(r.created_at as string),
      payload: asRecord(r.payload),
    }));
  }

  /**
   * Read outbound_context rows for the given scope — INCLUDING released and
   * expired-but-not-yet-swept entries, because that is exactly where the
   * diagnostic signal lives (an empty delegation_hint, a premature release).
   * `expired` is computed against now() so the agent can flag stale context.
   */
  async getOutboundContext(query: DiagnosticsQuery): Promise<OutboundContextRow[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (query.id) {
      params.push(query.id);
      conditions.push(`id = $${params.length}`);
    }
    if (query.conversationId) {
      params.push(query.conversationId);
      conditions.push(`conversation_id = $${params.length}`);
    }
    if (query.agentId) {
      params.push(query.agentId);
      conditions.push(`agent_id = $${params.length}`);
    }
    applyWindow(query, params, conditions);
    params.push(clampLimit(query.limit));

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT id, conversation_id, channel_id, agent_id, content_preview, expected_reply,
              delegation_hint, metadata, released, created_at, expires_at,
              (expires_at <= now()) AS expired
       FROM outbound_context
       ${where}
       ORDER BY created_at ASC
       LIMIT $${params.length}`,
      params,
    );
    this.logger.debug({ count: result.rows.length }, 'diagnostics-repo: getOutboundContext');
    return result.rows.map((r) => ({
      id: r.id as string,
      conversationId: r.conversation_id as string,
      channelId: r.channel_id as string,
      agentId: r.agent_id as string,
      contentPreview: r.content_preview as string,
      expectedReply: (r.expected_reply as string | null) ?? null,
      delegationHint: (r.delegation_hint as string | null) ?? null,
      metadata: asRecord(r.metadata),
      released: r.released as boolean,
      expired: r.expired as boolean,
      createdAt: new Date(r.created_at as string),
      expiresAt: new Date(r.expires_at as string),
    }));
  }

  /**
   * Read working_memory turns for a conversation/agent, INCLUDING archived rows
   * (retained past TTL for audit). `content` is the most sensitive field in the
   * system — the handler scrubs + truncates it before it leaves the skill.
   */
  async getWorkingMemory(query: DiagnosticsQuery): Promise<WorkingMemoryRow[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (query.id) {
      params.push(query.id);
      conditions.push(`id = $${params.length}`);
    }
    if (query.conversationId) {
      params.push(query.conversationId);
      conditions.push(`conversation_id = $${params.length}`);
    }
    if (query.agentId) {
      params.push(query.agentId);
      conditions.push(`agent_id = $${params.length}`);
    }
    if (query.role) {
      params.push(query.role);
      conditions.push(`role = $${params.length}`);
    }
    applyWindow(query, params, conditions);
    params.push(clampLimit(query.limit));

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT id, conversation_id, agent_id, role, content, archived, created_at, expires_at
       FROM working_memory
       ${where}
       ORDER BY created_at ASC
       LIMIT $${params.length}`,
      params,
    );
    this.logger.debug({ count: result.rows.length }, 'diagnostics-repo: getWorkingMemory');
    return result.rows.map((r) => ({
      id: r.id as string,
      conversationId: r.conversation_id as string,
      agentId: r.agent_id as string,
      role: r.role as string,
      content: r.content as string,
      archived: r.archived as boolean,
      createdAt: new Date(r.created_at as string),
      expiresAt: asDate(r.expires_at),
    }));
  }
}
