//
// Marks an outbound context bridge entry as released — stops expecting replies
// for that outbound message. Coordinator-only (enforced by allowed_callers).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContextBridgeReleaseHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { entry_id: entryId } = ctx.input as { entry_id?: string };

    if (!entryId || typeof entryId !== 'string') {
      return { success: false, error: 'Missing required input: entry_id (string)' };
    }

    if (!ctx.outboundContext) {
      return {
        success: false,
        error: 'context-bridge-release requires outboundContext capability.',
      };
    }

    try {
      await ctx.outboundContext.release(entryId);
      ctx.log.info({ entryId }, 'Context bridge entry released');
      return { success: true, data: { released: entryId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, entryId }, 'Failed to release context bridge entry');
      return { success: false, error: `Failed to release context bridge entry: ${message}` };
    }
  }
}
