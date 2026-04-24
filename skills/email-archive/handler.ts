// handler.ts — email-archive skill implementation.
//
// Archives an email by removing it from INBOX via the OutboundGateway.
// Used by the coordinator's observation-mode triage flow for emails that need
// no action (receipts, newsletters, automated notifications).
//
// Does NOT run through the outbound content filter — this is a folder-move
// operation, not an outbound communication.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailArchiveHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { message_id: rawMessageId, account } = ctx.input as {
      message_id?: string;
      account?: string;
    };

    // Trim to guard against accidental whitespace in the injected preamble values.
    const messageId = typeof rawMessageId === 'string' ? rawMessageId.trim() : undefined;

    if (!messageId) {
      return { success: false, error: 'Missing required input: message_id (string)' };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error:
          'email-archive skill requires outboundGateway access. Declare "outboundGateway" in capabilities.',
      };
    }

    // Treat an empty or whitespace-only string as "no account specified".
    const trimmedAccount = typeof account === 'string' ? account.trim() : '';
    const accountId = trimmedAccount.length > 0 ? trimmedAccount : undefined;

    ctx.log.info({ messageId, accountId }, 'Archiving email');

    let result: { success: boolean; error?: string };
    try {
      result = await ctx.outboundGateway.archiveEmailMessage(messageId, accountId);
    } catch (err) {
      ctx.log.error({ err, messageId, accountId }, 'email-archive: unexpected error from gateway');
      return { success: false, error: 'Archive failed' };
    }

    if (!result.success) {
      ctx.log.error({ messageId, accountId, error: result.error }, 'Failed to archive email');
      return { success: false, error: result.error ?? 'Archive failed' };
    }

    ctx.log.info({ messageId, accountId }, 'Email archived successfully');
    return { success: true, data: { archived: true } };
  }
}
