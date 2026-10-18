// handler.ts — ack-principal-reports (#2159).
//
// Advances the digest marker to a cursor from list-principal-reports, after the digest has
// been sent. The cursor must name a real report row, so a made-up one cannot hide what is
// waiting. A soft-rejected or failed config-store write is returned as an error: the marker
// stays put and the items repeat in the next digest, rather than being dropped.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { ReportQueue, InvalidReportCursorError } from '../../../../src/reports/report-queue.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';

export class AckPrincipalReportsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.auditLogRepo) {
      return { success: false, error: 'ack-principal-reports requires auditLogRepo capability' };
    }
    if (!ctx.entityMemory) {
      return { success: false, error: 'ack-principal-reports requires entityMemory capability' };
    }
    const cursor = typeof ctx.input.cursor === 'string' ? ctx.input.cursor.trim() : '';
    if (cursor === '') {
      return { success: false, error: 'cursor is required (from list-principal-reports)' };
    }

    const queue = new ReportQueue({
      auditLogRepo: ctx.auditLogRepo,
      configStore: new ConfigStore(ctx.entityMemory, ctx.log),
      logger: ctx.log,
    });

    try {
      const stored = await queue.ack(cursor);
      if (!stored) {
        return { success: false, error: 'Marker not stored; the items will repeat in the next digest.' };
      }
      return { success: true, data: 'Digest items acknowledged.' };
    } catch (err) {
      if (err instanceof InvalidReportCursorError) {
        ctx.log.warn({ cursor: cursor.slice(0, 40) }, 'ack-principal-reports: rejected a cursor it did not issue');
        return { success: false, error: 'That cursor was not issued by list-principal-reports; nothing acknowledged.' };
      }
      ctx.log.error({ err }, 'ack-principal-reports: failed to store the marker');
      return { success: false, error: 'The marker could not be stored; the items will repeat in the next digest.' };
    }
  }
}
