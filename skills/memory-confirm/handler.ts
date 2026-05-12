// handler.ts — memory-confirm skill
//
// Records the CEO's decision on a knowledge graph node flagged for re-confirmation.
//
// "confirm" — the CEO says the fact is still accurate. Resets last_confirmed_at = NOW()
// and confidence = 1.0, clears the warned_at flag. The node re-enters the normal
// decay cycle fresh, as if it was just confirmed today.
//
// "dismiss" — the CEO says the fact is no longer relevant. Archives immediately.
//
// Both operations are idempotent-safe: if the node is already archived or no longer
// in a warned state, the handler returns success: false rather than throwing.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class MemoryConfirmHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.entityMemory) {
      return { success: false, error: 'Entity memory service not available. Declare "entityMemory" in capabilities.' };
    }

    const { nodeId, action } = ctx.input as { nodeId: string; action: string };

    if (!nodeId || typeof nodeId !== 'string') {
      return { success: false, error: 'nodeId is required.' };
    }

    if (action !== 'confirm' && action !== 'dismiss') {
      return { success: false, error: `Invalid action "${action}". Must be "confirm" or "dismiss".` };
    }

    try {
      if (action === 'confirm') {
        const result = await ctx.entityMemory.confirmDecayWarning(nodeId);
        if (!result.success) {
          return { success: false, error: `Node ${nodeId} is not in a warned state (may already be archived or confirmed).` };
        }
        ctx.log.info({ nodeId, label: result.label }, 'memory-confirm: confirmed node');
        return { success: true, data: { action: 'confirmed', nodeId, label: result.label ?? '' } };
      } else {
        const result = await ctx.entityMemory.dismissDecayWarning(nodeId);
        if (!result.success) {
          return { success: false, error: `Node ${nodeId} is not in a warned state (may already be archived or dismissed).` };
        }
        ctx.log.info({ nodeId, label: result.label }, 'memory-confirm: dismissed node');
        return { success: true, data: { action: 'dismissed', nodeId, label: result.label ?? '' } };
      }
    } catch (err) {
      ctx.log.error({ err, nodeId, action }, 'memory-confirm: failed');
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to ${action} node: ${message}` };
    }
  }
}
