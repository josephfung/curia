// handler.ts — email-mark-read skill implementation.
//
// Marks an email as read via the OutboundGateway. Used after triage or
// processing to prevent re-processing on subsequent polling runs.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { validateNylasMessageId } from '../../../../src/channels/email/nylas-message-id.js';

export class EmailMarkReadHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { message_id: rawMessageId, account } = ctx.input as {
      message_id?: string;
      account?: string;
    };

    const messageId = typeof rawMessageId === 'string' ? rawMessageId.trim() : undefined;

    if (!messageId) {
      return { success: false, error: 'Missing required input: message_id (string)' };
    }

    const idError = validateNylasMessageId(messageId);
    if (idError) {
      return { success: false, error: idError, errorType: 'VALIDATION_ERROR' };
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

    let result: Awaited<ReturnType<typeof ctx.outboundGateway.markEmailAsRead>>;
    try {
      // ctx carries the call's abort signal and deadline (#2083).
      result = await ctx.outboundGateway.markEmailAsRead(messageId, accountId, ctx);
    } catch (err) {
      ctx.log.error({ err, messageId, accountId }, 'email-mark-read: unexpected error from gateway');
      return { success: false, error: 'Mark as read failed' };
    }

    if (!result.success) {
      ctx.log.error({ messageId, accountId, error: result.error }, 'Failed to mark email as read');
      return { success: false, error: result.error ?? 'Mark as read failed', errorType: result.errorType };
    }

    return { success: true, data: { marked_read: true } };
  }
}
