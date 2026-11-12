// handler.ts — ceo-inbox-send-draft: send one draft from the principal's own mailbox (#2474).
//
// Every decision lives in OutboundGateway.sendPrincipalDraft: the send setting, who is asking
// (live principal turn, not an approval replay), the draft's checks and the send itself. This
// handler only passes the call's authority through, unchanged, and relays the outcome. The
// authority fields come from the agent.task event, never from the model's input.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { checkMailboxInput } from '../../../_shared/principal-mailbox-client.js';
import { PRINCIPAL_SEND_REFUSALS, type PrincipalDraftSendResult } from '../../../../src/skills/outbound-gateway.js';

// Time kept back from the skill's deadline, so this handler answers before the execution
// layer's timeout does. That timeout's text reads like a refusal, but the send keeps running.
export const SEND_DEADLINE_RESERVE_MS = 1_000;

/**
 * Returned when the gateway call has not finished by the deadline or threw: the send's outcome
 * is unknown and it may still go out, so the agent must not report it either way or send again.
 */
export const SEND_OUTCOME_UNKNOWN =
  "The send didn't finish, so it may still go out. Don't send this draft again and don't report it as sent or as not sent; check the principal's Sent folder later.";

export class CeoInboxSendDraftHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'ceo-inbox-send-draft requires outboundGateway' };
    }

    const rawDraftId = ctx.input?.['draft_id'];
    const draftId = typeof rawDraftId === 'string' ? rawDraftId.trim() : '';
    if (!draftId) return { success: false, error: 'Missing required input: draft_id (string)' };

    // The mailbox is named by the draft itself until the gateway takes a mailbox; a given id must still be valid.
    const mailboxError = await checkMailboxInput(ctx, ctx.input, 'ceo-inbox-send-draft');
    if (mailboxError) return { success: false, error: mailboxError };

    // An approval replay is refused here as well as in the gateway (design D5): the execution
    // layer never queues this tool, so a replay can only be a stale or forged row.
    if (ctx.humanApproved === true) {
      ctx.log.warn({ draftId }, 'ceo-inbox-send-draft: approval replay refused');
      return { success: false, error: PRINCIPAL_SEND_REFUSALS.approval_replay };
    }

    const send = ctx.outboundGateway.sendPrincipalDraft(draftId, {
      authority: { liveTurn: ctx.liveTurn, taskMetadata: ctx.taskMetadata, humanApproved: ctx.humanApproved },
      taskEventId: ctx.taskEventId,
      conversationId: ctx.conversationId,
    });

    // Any end the gateway did not write itself (a throw, or no answer by the deadline) has an
    // unknown outcome: the send may be past the checks, or still running and about to go out.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: PrincipalDraftSendResult | 'unfinished';
    try {
      const racers: Array<Promise<PrincipalDraftSendResult | 'unfinished'>> = [send];
      if (ctx.deadline !== undefined) {
        const waitMs = Math.max(0, ctx.deadline - SEND_DEADLINE_RESERVE_MS - Date.now());
        racers.push(new Promise((resolve) => { timer = setTimeout(() => resolve('unfinished'), waitMs); }));
      }
      result = await Promise.race(racers);
    } catch (err) {
      ctx.log.error({ err, draftId }, 'ceo-inbox-send-draft: send threw — outcome unknown');
      return { success: false, error: SEND_OUTCOME_UNKNOWN };
    } finally {
      clearTimeout(timer);
    }
    if (result === 'unfinished') {
      // The gateway call keeps running; log how it ends, since the agent has already moved on.
      send.then(
        (late) => ctx.log.warn({ draftId, sent: late.success, refusal: late.success ? undefined : late.refusal }, 'ceo-inbox-send-draft: send finished after the deadline'),
        (err: unknown) => ctx.log.error({ err, draftId }, 'ceo-inbox-send-draft: send threw after the deadline'),
      );
      ctx.log.warn({ draftId }, 'ceo-inbox-send-draft: send unfinished at the deadline — outcome unknown');
      return { success: false, error: SEND_OUTCOME_UNKNOWN };
    }

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
