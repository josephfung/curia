import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { describeMessage } from '../../../_shared/ceo-nylas-client.js';
import { locateInMailbox, mailboxFields } from '../../../_shared/principal-mailbox-client.js';
import { nylasMessageFailure, validateNylasMessageId } from '../../../../src/channels/email/nylas-message-id.js';

export class CeoInboxArchiveHandler implements ToolHandler {
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

    const located = await locateInMailbox(ctx, input, 'ceo-inbox-archive', 'message', messageId);
    if (!located.ok) return { success: false, error: located.error, ...(located.errorType ? { errorType: located.errorType } : {}) };
    const { client, mailbox } = located.at;
    const mbx = mailboxFields(mailbox);

    ctx.log.info({ messageId }, 'ceo-inbox-archive: archiving message');

    try {
      // Fetch current folders, then remove INBOX
      const msg = await client.getMessage(messageId);
      // Already fetched, so naming the email costs no extra call. The spot-check pool shows
      // it to the principal; "Archive an email" alone cannot be graded.
      const described = describeMessage(msg);
      const currentFolders = msg.folders ?? [];
      const withoutInbox = currentFolders.filter(
        (f) => f.toUpperCase() !== 'INBOX',
      );

      if (withoutInbox.length === currentFolders.length) {
        // INBOX label not present — already archived
        ctx.log.info({ messageId }, 'ceo-inbox-archive: already archived');
        // already_archived tells the execution layer nothing changed, so the call is not put
        // in the spot-check pool for the principal to grade (#2159).
        return { success: true, data: { message_id: messageId, ...described, already_archived: true, ...mbx } };
      }

      await client.updateMessageFolders(messageId, withoutInbox);

      ctx.log.info({ messageId }, 'ceo-inbox-archive: archived successfully');
      return { success: true, data: { message_id: messageId, ...described, ...mbx } };
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-archive: failed to archive');
      return { success: false, ...nylasMessageFailure(err, messageId, 'Failed to archive principal inbox message') };
    }
  }
}
