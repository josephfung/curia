// handler.ts — ceo-inbox-send-draft: send one draft from the principal's own mailbox (#2474).
//
// Every decision lives in OutboundGateway.sendPrincipalDraft: the send setting, who is asking
// (live principal turn, not an approval replay), the draft's checks and the send itself. This
// handler only passes the call's authority through, unchanged, and relays the outcome. The
// authority fields come from the agent.task event, never from the model's input.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { PRINCIPAL_SEND_REFUSALS } from '../../../../src/skills/outbound-gateway.js';

export class CeoInboxSendDraftHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'ceo-inbox-send-draft requires outboundGateway' };
    }

    const rawDraftId = ctx.input?.['draft_id'];
    const draftId = typeof rawDraftId === 'string' ? rawDraftId.trim() : '';
    if (!draftId) return { success: false, error: 'Missing required input: draft_id (string)' };

    // An approval replay is refused here as well as in the gateway (design D5): the execution
    // layer never queues this tool, so a replay can only be a stale or forged row.
    if (ctx.humanApproved === true) {
      ctx.log.warn({ draftId }, 'ceo-inbox-send-draft: approval replay refused');
      return { success: false, error: PRINCIPAL_SEND_REFUSALS.approval_replay };
    }

    const result = await ctx.outboundGateway.sendPrincipalDraft(draftId, {
      authority: { liveTurn: ctx.liveTurn, taskMetadata: ctx.taskMetadata, humanApproved: ctx.humanApproved },
      taskEventId: ctx.taskEventId,
      conversationId: ctx.conversationId,
    });

    if (!result.success) {
      // Never retried: a refusal is final, and a failed send may have gone out (the gateway
      // does not retry either). Every refusal but send_unconfirmed leaves the draft in the
      // principal's Drafts folder; send_unconfirmed's text says to check Sent.
      ctx.log.info({ draftId, refusal: result.refusal, leftAsDraft: result.leftAsDraft }, 'ceo-inbox-send-draft: not sent');
      return { success: false, error: result.blockedReason ?? 'The draft was not sent.' };
    }

    return {
      success: true,
      data: { message_id: result.messageId ?? '', to: result.to ?? [], subject: result.subject ?? '' },
    };
  }
}
