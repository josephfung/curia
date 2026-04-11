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
    const { message_id: messageId, account } = ctx.input as {
      message_id?: string;
      account?: string;
    };

    if (!messageId || typeof messageId !== 'string') {
      return { success: false, error: 'Missing required input: message_id (string)' };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error:
          'email-archive skill requires outboundGateway access. Is infrastructure: true set in the manifest and outboundGateway passed to ExecutionLayer?',
      };
    }

    // Treat an empty string as "no account specified" so the gateway uses the primary client.
    const accountId = typeof account === 'string' && account.length > 0 ? account : undefined;

    ctx.log.info({ messageId, accountId }, 'Archiving email');

    const result = await ctx.outboundGateway.archiveEmailMessage(messageId, accountId);

    if (!result.success) {
      ctx.log.error({ messageId, accountId, error: result.error }, 'Failed to archive email');
      return { success: false, error: result.error ?? 'Archive failed' };
    }

    ctx.log.info({ messageId, accountId }, 'Email archived successfully');
    return { success: true, data: { archived: true } };
  }
}
