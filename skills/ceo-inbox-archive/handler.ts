import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';

export class CeoInboxArchiveHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const apiKey = ctx.secret('nylas_api_key');
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const messageId =
      typeof input.message_id === 'string' ? input.message_id.trim() : '';

    if (!messageId) {
      return { success: false, error: 'message_id is required' };
    }

    ctx.log.info({ messageId }, 'ceo-inbox-archive: archiving message');

    try {
      // Fetch current folders, then remove INBOX
      const msg = await client.getMessage(messageId);
      const currentFolders = msg.folders ?? [];
      const withoutInbox = currentFolders.filter(
        (f) => f.toUpperCase() !== 'INBOX',
      );

      if (withoutInbox.length === currentFolders.length) {
        // INBOX label not present — already archived
        ctx.log.info({ messageId }, 'ceo-inbox-archive: already archived');
        return { success: true, data: { message_id: messageId } };
      }

      await client.updateMessageFolders(messageId, withoutInbox);

      ctx.log.info({ messageId }, 'ceo-inbox-archive: archived successfully');
      return { success: true, data: { message_id: messageId } };
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-archive: failed to archive');
      return { success: false, error: 'Failed to archive CEO inbox message' };
    }
  }
}
