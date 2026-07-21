//
// Bulk-release outbound context bridge entries by meeting subject. Given one or
// more subjects (meeting names), releases EVERY active entry whose metadata
// subject matches — not just the ones visible in the turn's [ACTIVE OUTBOUND
// CONTEXT] block — and returns the actual released set so the coordinator can
// confirm exactly what was cleared. Access is controlled by pinning (no
// allowed_callers), matching the context-bridge-release convention.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

export class ContextBridgeClearHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as { subjects?: unknown; subject?: unknown };

    // Accept either `subjects: string[]` or a single `subject: string`. Prefer
    // `subjects` only when it actually has entries — an empty `subjects` array
    // must not shadow a provided single `subject` (e.g. `{ subjects: [], subject: "X" }`).
    const raw: unknown[] = Array.isArray(input.subjects) && input.subjects.length > 0
      ? input.subjects
      : typeof input.subject === 'string'
        ? [input.subject]
        : [];

    const subjects = raw
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => s.length > 0);

    if (subjects.length === 0) {
      return {
        success: false,
        error: 'Missing required input: subjects (non-empty string[]) or subject (string)',
      };
    }

    if (!ctx.outboundContext) {
      return {
        success: false,
        error: 'context-bridge-clear requires outboundContext capability.',
      };
    }

    try {
      const result = await ctx.outboundContext.clearBySubjects(subjects);
      ctx.log.info(
        {
          released: result.totalReleased,
          matched: result.perSubject.length,
          unmatched: result.unmatched.length,
        },
        'Context bridge entries cleared by subject',
      );
      return {
        success: true,
        data: {
          released: result.totalReleased,
          cleared: result.perSubject.map((p) => ({ subject: p.subject, count: p.released })),
          unmatched: result.unmatched,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to clear context bridge entries by subject');
      return { success: false, error: `Failed to clear context bridge entries: ${message}` };
    }
  }
}
