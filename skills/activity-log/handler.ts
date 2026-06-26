// skills/activity-log/handler.ts
//
// Read-only query of audit_log skill.result rows for CEO-facing activity recap.
// Summarizes consequential autonomous actions without returning raw payloads.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { AuditLogRow } from '../../src/audit/audit-log-repo.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Skills whose completed executions belong in a CEO activity recap by default. */
const DEFAULT_RECAP_SKILLS = new Set([
  'calendar-respond-to-invite',
  'calendar-create-event',
  'calendar-update-event',
  'calendar-delete-event',
  'calendar-create-hold',
  'email-send',
  'email-reply',
  'signal-send',
  'send-draft',
  'contact-create',
  'contact-update',
  'contact-merge',
  'contact-register',
  'approve-action',
]);

interface ActivityLogInput {
  since?: string;
  until?: string;
  skill_name?: string;
  agent_id?: string;
  limit?: number;
}

export class ActivityLogHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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

    const skillNames = input.skill_name
      ? [input.skill_name.trim()].filter(Boolean)
      : undefined;

    try {
      const rows = await ctx.auditLogRepo.findSkillResults({
        since,
        until,
        skillNames,
        agentId: typeof input.agent_id === 'string' ? input.agent_id : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });

      const autonomyRows = ctx.actionLogRepo
        ? await ctx.actionLogRepo.findTerminalBetween(since, until)
        : [];

      const tz = ctx.timezone;
      const actions = rows
        .map((row) => summarizeSkillResult(row, autonomyRows, tz))
        .filter((action): action is NonNullable<typeof action> => action !== null)
        .filter((action) => skillNames ? true : DEFAULT_RECAP_SKILLS.has(action.skill));

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

function summarizeSkillResult(
  row: AuditLogRow,
  autonomyRows: ActionLogRow[],
  tz?: string,
): {
  timestamp: string;
  skill: string;
  agent_id: string;
  target: string;
  outcome: 'completed' | 'failed';
  detail: string | null;
  autonomy: 'autonomous' | 'approved' | 'unknown';
} | null {
  const skillName = typeof row.payload.skillName === 'string' ? row.payload.skillName : null;
  if (!skillName) return null;

  const result = row.payload.result as { success?: boolean; data?: unknown; error?: string } | undefined;
  const success = result?.success === true;
  const autonomy = matchAutonomyOutcome(skillName, row.timestamp, autonomyRows);

  return {
    timestamp: toLocalIso(Math.floor(row.timestamp.getTime() / 1000), tz) ?? row.timestamp.toISOString(),
    skill: skillName,
    agent_id: row.sourceId,
    target: extractTarget(skillName, result),
    outcome: success ? 'completed' : 'failed',
    detail: success ? extractSuccessDetail(skillName, result?.data) : (result?.error ?? null),
    autonomy,
  };
}

function matchAutonomyOutcome(
  skillName: string,
  timestamp: Date,
  autonomyRows: ActionLogRow[],
): 'autonomous' | 'approved' | 'unknown' {
  const windowMs = 5 * 60 * 1000;
  const match = autonomyRows.find((row) =>
    row.skillName === skillName
    && Math.abs(row.createdAt.getTime() - timestamp.getTime()) <= windowMs,
  );
  if (!match) return 'unknown';
  if (match.outcome === 'approved') return 'approved';
  if (match.outcome === 'success') return 'autonomous';
  return 'unknown';
}

function extractTarget(skillName: string, result?: { success?: boolean; data?: unknown; error?: string }): string {
  const data = asRecord(result?.data);
  if (!data) return skillName;

  if (skillName === 'calendar-respond-to-invite') {
    const event = asRecord(data.event);
    const title = typeof event?.title === 'string' ? event.title : null;
    const response = typeof data.response === 'string' ? data.response : null;
    if (title && response) return `${response} — ${title}`;
    if (title) return title;
    if (response) return response;
  }

  if (skillName.startsWith('email-') || skillName === 'signal-send' || skillName === 'send-draft') {
    const to = data.to ?? data.recipient;
    if (typeof to === 'string') return to;
    if (Array.isArray(to) && typeof to[0] === 'string') return to[0];
  }

  if (skillName.startsWith('calendar-')) {
    const event = asRecord(data.event);
    if (typeof event?.title === 'string') return event.title;
  }

  if (typeof data.description === 'string') return data.description;
  if (typeof data.title === 'string') return data.title;
  if (typeof data.subject === 'string') return data.subject;

  return skillName;
}

function extractSuccessDetail(skillName: string, data: unknown): string | null {
  const record = asRecord(data);
  if (!record) return null;

  if (skillName === 'calendar-respond-to-invite') {
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
