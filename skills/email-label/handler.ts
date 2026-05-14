// handler.ts — email-label skill implementation.
//
// Applies one or more labels (Gmail folders) to an email message via the
// OutboundGateway. Creates labels that don't yet exist. Preserves all
// existing labels on the message (merge, not replace).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailLabelHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const rawMessageId = input.message_id;
    const messageId = typeof rawMessageId === 'string' ? rawMessageId.trim() : undefined;

    if (!messageId) {
      return { success: false, error: 'Missing required input: message_id (string)' };
    }

    const labels = Array.isArray(input.labels)
      ? input.labels
          .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
          .map((l) => l.trim())
      : [];

    if (labels.length === 0) {
      return { success: false, error: 'labels array is required and must contain at least one label' };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-label requires outboundGateway (capabilities: ["outboundGateway"])',
      };
    }

    const account = input.account;
    const trimmedAccount = typeof account === 'string' ? account.trim() : '';
    const accountId = trimmedAccount.length > 0 ? trimmedAccount : undefined;

    ctx.log.info({ messageId, labels, accountId }, 'Applying labels to email');

    let result: { success: boolean; applied: string[]; created: string[]; folders: string[]; error?: string };
    try {
      result = await ctx.outboundGateway.labelEmailMessage(messageId, labels, accountId);
    } catch (err) {
      ctx.log.error({ err, messageId, labels, accountId }, 'email-label: unexpected error from gateway');
      return { success: false, error: 'Label operation failed' };
    }

    if (!result.success) {
      ctx.log.error({ messageId, labels, accountId, error: result.error }, 'Failed to apply labels');
      return { success: false, error: result.error ?? 'Label operation failed' };
    }

    ctx.log.info(
      { messageId, applied: result.applied, created: result.created, accountId },
      'Labels applied successfully',
    );

    return {
      success: true,
      data: {
        message_id: messageId,
        applied: result.applied,
        created: result.created,
        folders: result.folders,
      },
    };
  }
}
