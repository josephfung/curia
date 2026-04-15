// handler.ts — email-get skill implementation.
//
// Fetches a single email message (full body) by Nylas message ID.
// Routes via OutboundGateway.getEmailMessage() — account resolution
// is handled by the gateway's named-client map.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailGetHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-get requires outboundGateway (infrastructure: true)' };
    }

    // Handlers must never throw — destructuring a non-object ctx.input would.
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const { message_id: rawId, account } = input as {
      message_id?: string;
      account?: string;
    };

    const messageId = typeof rawId === 'string' ? rawId.trim() : undefined;
    if (!messageId) {
      return { success: false, error: 'Missing required input: message_id (string)' };
    }

    const accountId = typeof account === 'string' && account.trim() ? account.trim() : undefined;

    ctx.log.info({ messageId, accountId }, 'email-get: fetching message');

    let message: Awaited<ReturnType<typeof ctx.outboundGateway.getEmailMessage>>;
    try {
      message = await ctx.outboundGateway.getEmailMessage(messageId, accountId);
    } catch (err) {
      ctx.log.error({ err, messageId, accountId }, 'email-get: failed to fetch message');
      return { success: false, error: 'Failed to fetch message' };
    }

    return {
      success: true,
      data: {
        message: {
          id: message.id,
          threadId: message.threadId,
          subject: message.subject,
          from: message.from,
          to: message.to,
          cc: message.cc,
          body: message.body,
          date: message.date,
          unread: message.unread,
          folders: message.folders,
        },
      },
    };
  }
}
