import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';

export class CeoInboxMarkStarredHandler implements SkillHandler {
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

    // LLM tool calls may serialize booleans as strings; accept "true"/"false" explicitly.
    // Default to true (star) when the field is omitted; reject other non-boolean values.
    const starredRaw = input.starred;
    let starred: boolean;
    if (starredRaw === undefined) {
      starred = true;
    } else if (typeof starredRaw === 'boolean') {
      starred = starredRaw;
    } else if (starredRaw === 'true') {
      starred = true;
    } else if (starredRaw === 'false') {
      starred = false;
    } else {
      return { success: false, error: 'starred must be a boolean' };
    }

    ctx.log.info({ messageId, starred }, 'ceo-inbox-mark-starred: setting starred');

    try {
      await client.markAsStarred(messageId, starred);
      return { success: true, data: { message_id: messageId, starred } };
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-mark-starred: failed');
      return { success: false, error: 'Failed to mark message as starred' };
    }
  }
}
