// skills/activity-log/handler.ts
//
// Read-only query of audit_log tool.result rows for CEO-facing activity recap.
// Summarizes consequential autonomous actions without returning raw payloads.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { AuditLogRow } from '../../src/audit/audit-log-repo.js';
import { readAuditToolName } from '../../src/audit/legacy-tool-events.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';
import { getRecapEligibleToolNames } from '../../src/skills/recap-skills.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

interface ActivityLogInput {
  since?: string;
  until?: string;
  tool_name?: string;
  agent_id?: string;
  limit?: number;
}

export class ActivityLogHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.auditLogRepo) {
      return { success: false, error: 'activity-log requires auditLogRepo capability' };
    }

    const input = ctx.input as ActivityLogInput;
    if (!input.since || typeof input.since !== 'string') {
      return { success: false, error: 'Missing required input: since' };
    }
    if (!ISO_DATETIME_RE.test(input.since) || Number.isNaN(new Date(input.since).getTime())) {
      return { success: false, error: 'since must be a valid ISO 8601 date string' };
    }

    const since = new Date(input.since);
    const until = input.until ? new Date(input.until) : new Date();
    if (input.until && (Number.isNaN(until.getTime()) || !ISO_DATETIME_RE.test(input.until))) {
      return { success: false, error: 'until must be a valid ISO 8601 date string' };
    }
    if (until <= since) {
      return { success: false, error: 'until must be after since' };
    }

    const toolNames = input.tool_name
      ? [input.tool_name.trim()].filter(Boolean)
      : undefined;

    try {
      const rows = await ctx.auditLogRepo.findToolResults({
        since,
        until,
        toolNames,
        agentId: typeof input.agent_id === 'string' ? input.agent_id : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });

      const autonomyRows = ctx.actionLogRepo
        ? await ctx.actionLogRepo.findTerminalBetween(since, until)
        : [];

      const tz = ctx.timezone;
      const recapTools = getRecapEligibleToolNames();
      const actions = rows
        .map((row) => summarizeToolResult(row, autonomyRows, tz))
        .filter((action): action is NonNullable<typeof action> => action !== null)
        .filter((action) => toolNames ? true : recapTools.has(action.tool));

      return {
        success: true,
        data: {
          actions,
          count: actions.length,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : undefined,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'activity-log: failed to query audit log');
      return { success: false, error: 'Unable to load recent activity right now.' };
    }
  }
}

function summarizeToolResult(
  row: AuditLogRow,
  autonomyRows: ActionLogRow[],
  tz?: string,
): {
  timestamp: string;
  tool: string;
  agent_id: string;
  target: string;
  outcome: 'completed' | 'failed';
  detail: string | null;
  autonomy: 'autonomous' | 'approved' | 'unknown';
} | null {
  const toolName = readAuditToolName(row.payload, {
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
  }) ?? null;
  if (!toolName) return null;

  const result = row.payload.result as { success?: boolean; data?: unknown; error?: string } | undefined;
  // Prefer structured outcome column; fall back to payload for pre-hardening rows.
  const success = row.outcome === 'success'
    ? true
    : row.outcome === 'failure' || row.outcome === 'error' || row.outcome === 'denied'
      ? false
      : result?.success === true;
  const autonomy = matchAutonomyOutcome(toolName, row.timestamp, row.conversationId, autonomyRows);

  // Human-readable target still comes from result data when available; fall back
  // to structured target_id (tool name) for rows where payload detail is thin.
  const targetFromPayload = extractTarget(toolName, result);
  const target = targetFromPayload !== toolName
    ? targetFromPayload
    : (row.targetId && row.targetId !== '[EXTRACTION_FAILED]' ? row.targetId : targetFromPayload);

  return {
    timestamp: toLocalIso(Math.floor(row.timestamp.getTime() / 1000), tz) ?? row.timestamp.toISOString(),
    tool: toolName,
    agent_id: row.initiatorId && row.initiatorType === 'agent'
      ? row.initiatorId
      : row.sourceId,
    target,
    outcome: success ? 'completed' : 'failed',
    detail: success ? extractSuccessDetail(toolName, result?.data) : (result?.error ?? null),
    autonomy,
  };
}

function matchAutonomyOutcome(
  toolName: string,
  timestamp: Date,
  conversationId: string | null,
  autonomyRows: ActionLogRow[],
): 'autonomous' | 'approved' | 'unknown' {
  const windowMs = 5 * 60 * 1000;
  const candidates = autonomyRows.filter((row) => {
    if (row.toolName !== toolName) return false;
    if (conversationId && row.conversationId && row.conversationId !== conversationId) return false;
    return Math.abs(row.createdAt.getTime() - timestamp.getTime()) <= windowMs;
  });
  if (candidates.length === 0) return 'unknown';
  const match = candidates.find((row) => row.outcome === 'approved')
    ?? candidates.find((row) => row.outcome === 'success')
    ?? candidates[0]!;
  if (match.outcome === 'approved') return 'approved';
  if (match.outcome === 'success') return 'autonomous';
  return 'unknown';
}

function extractTarget(toolName: string, result?: { success?: boolean; data?: unknown; error?: string }): string {
  const data = asRecord(result?.data);
  if (!data) return toolName;

  if (toolName === 'calendar-respond-to-invite') {
    const event = asRecord(data.event);
    const title = typeof event?.title === 'string' ? event.title : null;
    const response = typeof data.response === 'string' ? data.response : null;
    if (title && response) return `${response} — ${title}`;
    if (title) return title;
    if (response) return response;
  }

  if (toolName.startsWith('email-') || toolName === 'signal-send' || toolName === 'send-draft') {
    const to = data.to ?? data.recipient;
    if (typeof to === 'string') return to;
    if (Array.isArray(to) && typeof to[0] === 'string') return to[0];
  }

  if (toolName.startsWith('calendar-')) {
    const event = asRecord(data.event);
    if (typeof event?.title === 'string') return event.title;
  }

  if (typeof data.description === 'string') return data.description;
  if (typeof data.title === 'string') return data.title;
  if (typeof data.subject === 'string') return data.subject;

  return toolName;
}

function extractSuccessDetail(toolName: string, data: unknown): string | null {
  const record = asRecord(data);
  if (!record) return null;

  if (toolName === 'calendar-respond-to-invite') {
    const response = typeof record.response === 'string' ? record.response : null;
    const released = Array.isArray(record.releasedHolds) ? record.releasedHolds.length : null;
    if (response && released !== null) return `RSVP ${response}; released ${released} hold(s)`;
    if (response) return `RSVP ${response}`;
  }

  if (typeof record.message === 'string') return record.message;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
