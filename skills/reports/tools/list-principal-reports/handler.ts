// handler.ts — list-principal-reports (#2159).
//
// Returns the digest items waiting since the last acknowledged digest, numbered 1..N.
// Reading never moves the marker: the digest calls ack-principal-reports with the returned
// cursor after it has been sent, so a digest that fails to send repeats its items.
// Audit ids are never returned — the principal sees numbers, not ids (mobile UX).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { refuseOutsiderDigestAccess } from '../../../../src/skills/_shared/principal-directed.js';
import { ReportQueue } from '../../../../src/reports/report-queue.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';

export class ListPrincipalReportsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    // An outside contact's task never reads or acknowledges the principal's digest (#1320).
    const refused = refuseOutsiderDigestAccess(ctx);
    if (refused) return refused;
    if (!ctx.auditLogRepo) {
      return { success: false, error: 'list-principal-reports requires auditLogRepo capability' };
    }
    if (!ctx.entityMemory) {
      return { success: false, error: 'list-principal-reports requires entityMemory capability' };
    }

    const queue = new ReportQueue({
      auditLogRepo: ctx.auditLogRepo,
      configStore: new ConfigStore(ctx.entityMemory, ctx.log),
      logger: ctx.log,
    });

    try {
      const batch = await queue.list();
      const tz = ctx.timezone;
      return {
        success: true,
        data: {
          items: batch.items.map((item, i) => ({
            n: i + 1,
            at: toLocalIso(Math.floor(item.at.getTime() / 1000), tz),
            summary: item.summary,
            urgency: item.urgency,
            ...(item.link ? { link: item.link } : {}),
          })),
          cursor: batch.cursor,
          hasMore: batch.hasMore,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : undefined,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'list-principal-reports: failed to read the report queue');
      return { success: false, error: 'Could not read the report queue' };
    }
  }
}
