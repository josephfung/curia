// handler.ts — report-to-principal (#2159).
//
// Files an item for the principal's next digest: something done on their behalf, a decision,
// or how an ambiguous instruction was read. It never messages the principal; the digest
// carries the item. Published from the dispatch layer, like the other tools that write
// principal-facing records (deny-action's human.decision).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { createPrincipalReport, type PrincipalReportUrgency } from '../../../../src/bus/events.js';

const MAX_SUMMARY = 500;
const URGENCIES: readonly PrincipalReportUrgency[] = ['digest', 'now'];

export class ReportToPrincipalHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.bus) {
      return { success: false, error: 'report-to-principal requires bus capability' };
    }
    if (!ctx.taskEventId) {
      return { success: false, error: 'report-to-principal needs a task context' };
    }

    const summary = typeof ctx.input.summary === 'string' ? ctx.input.summary.trim() : '';
    if (summary === '') {
      return { success: false, error: 'summary is required' };
    }
    if (summary.length > MAX_SUMMARY) {
      return { success: false, error: `summary must be at most ${MAX_SUMMARY} characters` };
    }
    const rawUrgency = ctx.input.urgency ?? 'digest';
    if (typeof rawUrgency !== 'string' || !(URGENCIES as readonly string[]).includes(rawUrgency)) {
      return { success: false, error: "urgency must be 'digest' or 'now'" };
    }
    const link = typeof ctx.input.link === 'string' && ctx.input.link.trim() !== '' ? ctx.input.link.trim() : undefined;

    try {
      await ctx.bus.publish('dispatch', createPrincipalReport({
        summary,
        urgency: rawUrgency as PrincipalReportUrgency,
        source: 'agent',
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
        ...(link ? { link } : {}),
        parentEventId: ctx.taskEventId,
        sourceLayer: 'dispatch',
      }));
    } catch (err) {
      ctx.log.error({ err, summaryLength: summary.length }, 'report-to-principal: failed to publish principal.report');
      return { success: false, error: 'Could not record the report item' };
    }

    return { success: true, data: 'Recorded for the principal\'s next digest.' };
  }
}
