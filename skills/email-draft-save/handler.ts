// handler.ts — email-draft-save skill implementation.
//
// Saves a draft email without sending it. Routes via OutboundGateway.createEmailDraft(),
// which runs the blocked-contact check and converts markdown to HTML.
//
// Use this for the NEEDS DRAFT triage category: coordinator writes the draft,
// the CEO reviews and sends it from their email client.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailDraftSaveHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-draft-save requires outboundGateway (infrastructure: true)' };
    }

    const { to: rawTo, subject, body, account, reply_to_message_id } = ctx.input as {
      to?: string;
      subject?: string;
      body?: string;
      account?: string;
      reply_to_message_id?: string;
    };

    const to = typeof rawTo === 'string' ? rawTo.trim() : undefined;
    if (!to) return { success: false, error: 'Missing required input: to (string)' };
    if (!subject || typeof subject !== 'string') return { success: false, error: 'Missing required input: subject (string)' };
    if (!body || typeof body !== 'string') return { success: false, error: 'Missing required input: body (string)' };

    const accountId = typeof account === 'string' && account.trim() ? account.trim() : undefined;
    const replyToMessageId = typeof reply_to_message_id === 'string' && reply_to_message_id.trim()
      ? reply_to_message_id.trim()
      : undefined;

    ctx.log.info({ to, subject, accountId, replyToMessageId }, 'email-draft-save: saving draft');

    let result: Awaited<ReturnType<typeof ctx.outboundGateway.createEmailDraft>>;
    try {
      result = await ctx.outboundGateway.createEmailDraft({
        channel: 'email',
        to,
        subject,
        body,
        accountId,
        replyToMessageId,
      });
    } catch (err) {
      ctx.log.error({ err, to, accountId }, 'email-draft-save: unexpected error saving draft');
      return { success: false, error: 'Failed to save draft' };
    }

    if (!result.success) {
      ctx.log.error({ to, accountId, reason: result.blockedReason }, 'email-draft-save: gateway rejected draft');
      return { success: false, error: result.blockedReason ?? 'Failed to save draft' };
    }

    // OutboundDraftResult.draftId is typed optional; guard so we never violate the
    // declared `draft_id: string` output contract by emitting `undefined`.
    if (!result.draftId) {
      ctx.log.error({ to, accountId }, 'email-draft-save: gateway returned success without draftId');
      return { success: false, error: 'Failed to save draft' };
    }

    ctx.log.info({ draftId: result.draftId, to, accountId }, 'email-draft-save: draft saved');
    return { success: true, data: { draft_id: result.draftId } };
  }
}
