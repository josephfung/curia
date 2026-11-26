// handler.ts — card-use-confirm skill (#1358, ADR-060).
//
// Writes the grant behind a card-use request. It runs only as an approval replay: the
// principal's yes (reply, reaction or console) re-invokes it with humanApproved. Any other
// call is refused, so the principal's answer is the only way a grant gets written. The
// manifest also restricts callers to 'system', so no agent can reach it.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

export const CARD_USE_CONFIRM_REFUSAL =
  'card-use-confirm runs only when the principal approves a card-use request.';

export class CardUseConfirmHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (ctx.humanApproved !== true) {
      ctx.log.warn({ agentId: ctx.agentId }, 'card-use-confirm: refused a call that is not an approval replay');
      return { success: false, error: CARD_USE_CONFIRM_REFUSAL };
    }
    if (!ctx.cardUse) {
      return { success: false, error: 'card-use-confirm requires the cardUse capability in context.' };
    }
    const requestId = ctx.input['request_id'];
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return { success: false, error: 'request_id is required.' };
    }

    try {
      const result = await ctx.cardUse.confirm(requestId, ctx.approvalVia, ctx.conversationId);
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, requestId }, 'card-use-confirm failed');
      return { success: false, error: message };
    }
  }
}
