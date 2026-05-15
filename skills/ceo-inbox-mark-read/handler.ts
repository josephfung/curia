import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';

export class CeoInboxMarkReadHandler implements SkillHandler {
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

    ctx.log.info({ messageId }, 'ceo-inbox-mark-read: marking as read');

    try {
      await client.markAsRead(messageId);
      return { success: true, data: { message_id: messageId } };
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-mark-read: failed');
      return { success: false, error: 'Failed to mark message as read' };
    }
  }
}
