// skills/ops-lookup/handler.ts
//
// Read-only lookup of the operational + agent-state tables for the diagnostics
// agent (#1356). One `source` per call selects a DiagnosticsRepo read method;
// content fields are PII-scrubbed and truncated (hardest on working_memory), and
// an empty scope returns available:false so the agent reports "unavailable /
// expired" rather than confabulating.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { DiagnosticsQuery, DiagnosticsRepo } from '../../../../src/diagnostics/diagnostics-repo.js';
import { redactText, summarizePayload } from '../../../../src/diagnostics/redact.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const SOURCES = ['scheduled_jobs', 'messages', 'action_log', 'outbound_context', 'working_memory'] as const;
type Source = (typeof SOURCES)[number];

interface OpsLookupInput {
  source?: string;
  id?: string;
  conversation_id?: string;
  task_id?: string;
  agent_id?: string;
  status?: string;
  skill_name?: string;
  outcome?: string;
  role?: string;
  since?: string;
  until?: string;
  limit?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export class OpsLookupHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const repo = ctx.diagnosticsRepo;
    if (!repo) {
      return { success: false, error: 'ops-lookup requires diagnosticsRepo capability' };
    }

    const input = ctx.input as OpsLookupInput;
    const source = str(input.source) as Source | undefined;
    if (!source || !SOURCES.includes(source)) {
      return { success: false, error: `source must be one of: ${SOURCES.join(', ')}` };
    }

    const from = this.parseIso(input.since);
    if (from === 'invalid') return { success: false, error: 'since must be a valid ISO 8601 date string' };
    const to = this.parseIso(input.until);
    if (to === 'invalid') return { success: false, error: 'until must be a valid ISO 8601 date string' };
    if (from && to && to <= from) {
      return { success: false, error: 'until must be after since' };
    }

    const query: DiagnosticsQuery = {
      id: str(input.id),
      conversationId: str(input.conversation_id),
      taskId: str(input.task_id),
      agentId: str(input.agent_id),
      status: str(input.status),
      toolName: str(input.skill_name),
      outcome: str(input.outcome),
      role: str(input.role),
      from: from || undefined,
      to: to || undefined,
      limit: typeof input.limit === 'number' && input.limit > 0 ? input.limit : undefined,
    };

    const tz = ctx.timezone;
    const fmt = (d: Date | null): string | null =>
      d ? (toLocalIso(Math.floor(d.getTime() / 1000), tz) ?? d.toISOString()) : null;

    try {
      const rows = await this.lookup(repo, source, query, fmt);
      return {
        success: true,
        data: {
          source,
          rows,
          count: rows.length,
          available: rows.length > 0,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : undefined,
        },
      };
    } catch (err) {
      ctx.log.error({ err, source }, 'ops-lookup: failed to query operational state');
      return { success: false, error: 'Unable to query operational state right now.' };
    }
  }

  private parseIso(value: string | undefined): Date | 'invalid' | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value) || Number.isNaN(new Date(value).getTime())) {
      return 'invalid';
    }
    return new Date(value);
  }

  private async lookup(
    repo: DiagnosticsRepo,
    source: Source,
    query: DiagnosticsQuery,
    fmt: (d: Date | null) => string | null,
  ): Promise<Array<Record<string, unknown>>> {
    switch (source) {
      case 'scheduled_jobs': {
        const jobs = await repo.getScheduledJobs(query);
        return jobs.map((j) => ({
          id: j.id,
          agent_id: j.agentId,
          source_agent_id: j.sourceAgentId,
          task_id: j.taskId,
          cron_expr: j.cronExpr,
          run_at: fmt(j.runAt),
          next_run_at: fmt(j.nextRunAt),
          last_run_at: fmt(j.lastRunAt),
          run_started_at: fmt(j.runStartedAt),
          status: j.status,
          last_run_outcome: j.lastRunOutcome,
          last_run_summary: redactText(j.lastRunSummary),
          last_error: redactText(j.lastError),
          consecutive_failures: j.consecutiveFailures,
          created_by: j.createdBy,
          created_at: fmt(j.createdAt),
          task_payload: summarizePayload(j.taskPayload),
        }));
      }
      case 'messages': {
        const msgs = await repo.getHeldMessages(query);
        return msgs.map((m) => ({
          id: m.id,
          channel: m.channel,
          sender_id: m.senderId,
          conversation_id: m.conversationId,
          subject: redactText(m.subject),
          content: redactText(m.content),
          status: m.status,
          metadata: summarizePayload(m.metadata),
          resolved_contact_id: m.resolvedContactId,
          created_at: fmt(m.createdAt),
          processed_at: fmt(m.processedAt),
        }));
      }
      case 'action_log': {
        const actions = await repo.getActionLog(query);
        return actions.map((a) => ({
          id: a.id,
          task_id: a.taskId,
          conversation_id: a.conversationId,
          skill_name: a.toolName,
          action_risk: a.actionRisk,
          outcome: a.outcome,
          task_summary: redactText(a.taskSummary),
          description: redactText(a.description),
          short_ref: a.shortRef,
          resolved_by: a.resolvedBy,
          resolved_at: fmt(a.resolvedAt),
          expires_at: fmt(a.expiresAt),
          created_at: fmt(a.createdAt),
          payload: summarizePayload(a.payload),
        }));
      }
      case 'outbound_context': {
        const entries = await repo.getOutboundContext(query);
        return entries.map((e) => ({
          id: e.id,
          conversation_id: e.conversationId,
          channel_id: e.channelId,
          agent_id: e.agentId,
          content_preview: redactText(e.contentPreview),
          expected_reply: redactText(e.expectedReply),
          delegation_hint: redactText(e.delegationHint),
          metadata: summarizePayload(e.metadata),
          released: e.released,
          expired: e.expired,
          created_at: fmt(e.createdAt),
          expires_at: fmt(e.expiresAt),
        }));
      }
      case 'working_memory': {
        const turns = await repo.getWorkingMemory(query);
        return turns.map((t) => ({
          id: t.id,
          conversation_id: t.conversationId,
          agent_id: t.agentId,
          role: t.role,
          content: redactText(t.content),
          archived: t.archived,
          created_at: fmt(t.createdAt),
          expires_at: fmt(t.expiresAt),
        }));
      }
    }
  }
}
