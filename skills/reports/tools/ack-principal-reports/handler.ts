// handler.ts — ack-principal-reports (#2159).
//
// Advances the digest marker to a cursor from list-principal-reports, after the digest has
// been sent. A soft-rejected config-store write is returned as an error: the marker stays
// put and the items repeat in the next digest, rather than being dropped.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { ReportQueue } from '../../../../src/reports/report-queue.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';

export class AckPrincipalReportsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.entityMemory) {
      return { success: false, error: 'ack-principal-reports requires entityMemory capability' };
    }
    const cursor = typeof ctx.input.cursor === 'string' ? ctx.input.cursor.trim() : '';
    if (cursor === '') {
      return { success: false, error: 'cursor is required (from list-principal-reports)' };
    }

    // ack() touches only the config store; the audit reader is unused on this path.
    const queue = new ReportQueue({
      auditLogRepo: { findByEventTypes: async () => ({ rows: [], hasMore: false }) },
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
      ctx.log.warn({ err }, 'ack-principal-reports: could not acknowledge');
      return { success: false, error: 'That cursor was not issued by list-principal-reports; nothing acknowledged.' };
    }
  }
}
