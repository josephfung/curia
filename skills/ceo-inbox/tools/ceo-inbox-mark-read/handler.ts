import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { locateInMailbox, mailboxFields } from '../../../_shared/principal-mailbox-client.js';
import { nylasMessageFailure, validateNylasMessageId } from '../../../../src/channels/email/nylas-message-id.js';

export class CeoInboxMarkReadHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const messageId =
      typeof input.message_id === 'string' ? input.message_id.trim() : '';

    if (!messageId) {
      return { success: false, error: 'message_id is required' };
    }

    const idError = validateNylasMessageId(messageId);
    if (idError) {
      return { success: false, error: idError, errorType: 'VALIDATION_ERROR' };
    }

    const located = await locateInMailbox(ctx, input, 'ceo-inbox-mark-read', 'message', messageId);
    if (!located.ok) return { success: false, error: located.error, ...(located.errorType ? { errorType: located.errorType } : {}) };
    const { client, mailbox } = located.at;
    const mbx = mailboxFields(mailbox);

    ctx.log.info({ messageId }, 'ceo-inbox-mark-read: marking as read');

    try {
      await client.markAsRead(messageId);
      return { success: true, data: { message_id: messageId, ...mbx } };
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-mark-read: failed');
      return { success: false, ...nylasMessageFailure(err, messageId, 'Failed to mark message as read') };
    }
  }
}
