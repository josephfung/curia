// skills/audit-query/handler.ts
//
// Read-only, flexible audit_log query for the diagnostics agent (#1356). Wraps
// AuditLogRepo's findById / findByBlockId / findByEventTypes / findTimeline and
// returns bounded, PII-scrubbed event records. No raw payloads leave the skill.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { AuditLogRow } from '../../src/audit/audit-log-repo.js';
import { toEventRecord } from '../../src/diagnostics/event-record.js';
import { formatDisplayTimezone } from '../../src/time/timestamp.js';

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

interface AuditQueryInput {
  event_id?: string;
  block_id?: string;
  conversation_id?: string;
  task_id?: string;
  event_types?: string[] | string;
  since?: string;
  until?: string;
  limit?: number;
}

function parseIso(value: string | undefined, field: string): { date?: Date; error?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value) || Number.isNaN(new Date(value).getTime())) {
    return { error: `${field} must be a valid ISO 8601 date string` };
  }
  return { date: new Date(value) };
}

export class AuditQueryHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.auditLogRepo) {
      return { success: false, error: 'audit-query requires auditLogRepo capability' };
    }

    const input = ctx.input as AuditQueryInput;
    const eventId = typeof input.event_id === 'string' ? input.event_id.trim() : undefined;
    const blockId = typeof input.block_id === 'string' ? input.block_id.trim() : undefined;
    const conversationId = typeof input.conversation_id === 'string' ? input.conversation_id.trim() : undefined;
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : undefined;
    const eventTypes = Array.isArray(input.event_types)
      ? input.event_types.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
      : typeof input.event_types === 'string' && input.event_types.trim().length > 0
        ? [input.event_types.trim()]
        : undefined;

    const since = parseIso(input.since, 'since');
    if (since.error) return { success: false, error: since.error };
    const until = parseIso(input.until, 'until');
    if (until.error) return { success: false, error: until.error };
    if (since.date && until.date && until.date <= since.date) {
      return { success: false, error: 'until must be after since' };
    }

    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : undefined;
    const tz = ctx.timezone;
    const displayTimezone = tz ? formatDisplayTimezone(tz, new Date()) : undefined;

    try {
      let rows: AuditLogRow[] = [];
      let hasMore = false;

      if (eventId) {
        const row = await ctx.auditLogRepo.findById(eventId);
        rows = row ? [row] : [];
      } else if (blockId) {
        rows = await ctx.auditLogRepo.findByBlockId(blockId, { from: since.date, to: until.date, limit });
      } else if (eventTypes && eventTypes.length > 0) {
        const page = await ctx.auditLogRepo.findByEventTypes(eventTypes, {
          from: since.date,
          to: until.date,
          conversationId,
          taskId,
          limit,
        });
        rows = page.rows;
        hasMore = page.hasMore;
      } else if (since.date || until.date || conversationId || taskId) {
        const page = await ctx.auditLogRepo.findTimeline({
          from: since.date,
          to: until.date,
          conversationId,
          taskId,
          limit,
        });
        rows = page.rows;
        hasMore = page.hasMore;
      } else {
        return {
          success: false,
          error: 'audit-query needs at least one anchor: event_id, block_id, conversation_id, task_id, event_types, or a since/until window',
        };
      }

      const events = rows.map((row) => toEventRecord(row, tz));
      return {
        success: true,
        data: {
          events,
          count: events.length,
          hasMore,
          available: events.length > 0,
          displayTimezone,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'audit-query: failed to query audit log');
      return { success: false, error: 'Unable to query the audit log right now.' };
    }
  }
}
