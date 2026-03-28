// handler.ts — email-reply skill implementation.
//
// Replies to an existing email thread via the OutboundGateway. The gateway
// enforces contact blocked checks and content filtering before dispatch.
// This handler focuses on thread resolution (fetching the original message
// to extract the sender address and subject line).
//
// sensitivity: "elevated" — enforced by the gateway's security pipeline.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const MAX_BODY_LENGTH = 50000;

export class EmailReplyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { reply_to_message_id: replyToMessageId, body } = ctx.input as {
      reply_to_message_id?: string;
      body?: string;
    };

    if (!replyToMessageId || typeof replyToMessageId !== 'string') {
      return { success: false, error: 'Missing required input: reply_to_message_id (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }

    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-reply skill requires outboundGateway access. Is infrastructure: true set in the manifest and outboundGateway passed to ExecutionLayer?',
      };
    }

    ctx.log.info({ replyToMessageId }, 'Replying to email via gateway');

    try {
      const original = await ctx.outboundGateway.getEmailMessage(replyToMessageId);

      const originalFrom = original.from[0]?.email;
      if (!originalFrom) {
        return {
          success: false,
          error: `Original message ${replyToMessageId} has no sender address — cannot reply`,
        };
      }

      const baseSubject = original.subject.replace(/^Re:\s*/i, '');
      const replySubject = `Re: ${baseSubject}`;

      const result = await ctx.outboundGateway.send({
        channel: 'email',
        to: originalFrom,
        subject: replySubject,
        body,
        replyToMessageId,
      });

      if (!result.success) {
        return { success: false, error: result.blockedReason ?? 'Email reply failed' };
      }

      ctx.log.info(
        { messageId: result.messageId, to: originalFrom, subject: replySubject },
        'Email reply sent successfully',
      );

      return {
        success: true,
        data: {
          message_id: result.messageId,
          to: originalFrom,
          subject: replySubject,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, replyToMessageId }, 'Failed to reply to email');
      return { success: false, error: `Failed to reply to email: ${message}` };
    }
  }
}
