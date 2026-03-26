// handler.ts — email-reply skill implementation.
//
// Replies to an existing email thread via the Nylas API. This is an
// infrastructure skill — it requires nylasClient access in its context.
// The skill fetches the original message to extract the sender's address
// and subject, then sends a properly threaded reply.
//
// sensitivity: "elevated" — this skill has real-world side effects (sends
// actual email). No approval flow exists yet; the flag is informational.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Input length limit — prevent oversized payloads reaching the email API
const MAX_BODY_LENGTH = 50000;

export class EmailReplyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { reply_to_message_id: replyToMessageId, body } = ctx.input as {
      reply_to_message_id?: string;
      body?: string;
    };

    // Validate required inputs
    if (!replyToMessageId || typeof replyToMessageId !== 'string') {
      return { success: false, error: 'Missing required input: reply_to_message_id (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }

    // Length limit
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    // Infrastructure skills need nylasClient
    if (!ctx.nylasClient) {
      return {
        success: false,
        error: 'email-reply skill requires nylasClient access. Is infrastructure: true set in the manifest and nylasClient passed to ExecutionLayer?',
      };
    }

    ctx.log.info({ replyToMessageId }, 'Replying to email');

    try {
      // Fetch the original message to get the sender and subject for threading
      const original = await ctx.nylasClient.getMessage(replyToMessageId);

      // Extract the original sender's email — this is who we're replying to
      const originalFrom = original.from[0]?.email;
      if (!originalFrom) {
        return {
          success: false,
          error: `Original message ${replyToMessageId} has no sender address — cannot reply`,
        };
      }

      const replySubject = `Re: ${original.subject}`;

      const sent = await ctx.nylasClient.sendMessage({
        to: [{ email: originalFrom }],
        subject: replySubject,
        body,
        replyToMessageId,
      });

      ctx.log.info(
        { messageId: sent.id, to: originalFrom, subject: replySubject },
        'Email reply sent successfully',
      );

      return {
        success: true,
        data: {
          message_id: sent.id,
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
