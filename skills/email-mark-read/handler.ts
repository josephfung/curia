// handler.ts — email-mark-read skill implementation.
//
// Marks an email as read via the OutboundGateway. Used after triage or
// processing to prevent re-processing on subsequent polling runs.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailMarkReadHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { message_id: rawMessageId, account } = ctx.input as {
      message_id?: string;
      account?: string;
    };

    const messageId = typeof rawMessageId === 'string' ? rawMessageId.trim() : undefined;

    if (!messageId) {
      return { success: false, error: 'Missing required input: message_id (string)' };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-mark-read requires outboundGateway (capabilities: ["outboundGateway"])',
      };
    }

    const trimmedAccount = typeof account === 'string' ? account.trim() : '';
    const accountId = trimmedAccount.length > 0 ? trimmedAccount : undefined;

    ctx.log.info({ messageId, accountId }, 'Marking email as read');

    let result: { success: boolean; error?: string };
    try {
      result = await ctx.outboundGateway.markEmailAsRead(messageId, accountId);
    } catch (err) {
      ctx.log.error({ err, messageId, accountId }, 'email-mark-read: unexpected error from gateway');
      return { success: false, error: 'Mark as read failed' };
    }

    if (!result.success) {
      ctx.log.error({ messageId, accountId, error: result.error }, 'Failed to mark email as read');
      return { success: false, error: result.error ?? 'Mark as read failed' };
    }

    return { success: true, data: { marked_read: true } };
  }
}
