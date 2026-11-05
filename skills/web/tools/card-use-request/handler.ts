// handler.ts — card-use-request skill (#1358, ADR-060).
//
// Files the principal's per-checkout approval to pay with a saved card. It never writes a
// grant: CardUseService.request records the request and files a pending approval for the
// internal card-use-confirm tool, which only an approval replay can run. The result carries
// the masked card and the approval reference, never the number.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { buildCaptureOrigin } from '../../../../src/secrets/build-capture-origin.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';

function requiredString(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export class CardUseRequestHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.cardUse) {
      return { success: false, error: 'card-use-request requires the cardUse capability in context.' };
    }
    if (!ctx.taskEventId || !ctx.conversationId) {
      return { success: false, error: 'card-use-request needs a conversation and task to attach the approval to.' };
    }

    const secretName = requiredString(ctx.input, 'secret_name');
    const siteUrl = requiredString(ctx.input, 'site_url');
    const amount = requiredString(ctx.input, 'amount');
    const purpose = requiredString(ctx.input, 'purpose');
    for (const [key, value] of [['secret_name', secretName], ['site_url', siteUrl], ['amount', amount], ['purpose', purpose]] as const) {
      if (value === null) return { success: false, error: `${key} is required and must be a non-empty string.` };
    }

    // Re-enter this agent (or the coordinator, for a delegated specialist) when the principal answers.
    const origin = buildCaptureOrigin(ctx, `Continue the purchase: ${purpose}`);

    try {
      const result = await ctx.cardUse.request(
        { secretName: secretName!, siteUrl: siteUrl!, amount: amount!, purpose: purpose! },
        { taskEventId: ctx.taskEventId, conversationId: ctx.conversationId, origin },
      );
      return {
        success: true,
        data: {
          approval_ref: result.shortRef,
          approval_number: result.approvalNumber,
          expires_at: toLocalIso(Math.floor(result.expiresAt.getTime() / 1000), ctx.timezone),
          card: result.card,
          displayTimezone: ctx.timezone ? formatDisplayTimezone(ctx.timezone, new Date()) : undefined,
          next_step: 'Call deliver-approval with approval_ref now, then wait for the principal. Do not approve it yourself.',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err }, 'card-use-request failed');
      return { success: false, error: message };
    }
  }
}
