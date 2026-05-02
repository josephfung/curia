// handler.ts — send-draft skill implementation.
//
// Sends a Nylas draft email on explicit CEO authorization.
//
// SECURITY: The task-origin check (ctx.taskMetadata?.ceoInitiated === true) is the
// primary gate. That flag is stamped by the dispatch layer in TypeScript code before
// the coordinator sees the task — the LLM cannot set it. Observation-mode tasks
// (external emails) explicitly do not receive this flag, preventing prompt injection
// from external sources from triggering approved sends.
//
// See ADR-017 for the full reasoning behind this pattern.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';

export class SendDraftHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // ------------------------------------------------------------------
    // Step 1: Task-origin check — hard gate, must be first
    // ------------------------------------------------------------------
    // ctx.taskMetadata is populated by the agent runtime from the agent.task
    // event payload; the LLM cannot influence it. Observation-mode tasks
    // (triggered by external emails) explicitly do not receive ceoInitiated,
    // so prompt injection from an external email cannot reach this point with
    // the flag set.
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn(
        { ceoInitiated: ctx.taskMetadata?.ceoInitiated },
        'send-draft: rejected — ceoInitiated flag absent or false in task metadata',
      );
      return {
        success: false,
        error: 'send-draft requires direct CEO authorization. This skill can only be called from a task initiated by the CEO.',
      };
    }

    if (!ctx.outboundGateway) {
      return { success: false, error: 'send-draft requires outboundGateway (capabilities: ["outboundGateway"])' };
    }

    if (!ctx.bus) {
      return { success: false, error: 'send-draft requires bus (capabilities: ["bus"])' };
    }

    // ------------------------------------------------------------------
    // Step 2: Parse inputs
    // ------------------------------------------------------------------
    const input = ctx.input && typeof ctx.input === 'object'
      ? (ctx.input as Record<string, unknown>)
      : {};
    const { draft_id: rawDraftId, account: rawAccount } = input as {
      draft_id?: string;
      account?: string;
    };

    const draftId = typeof rawDraftId === 'string' && rawDraftId.trim()
      ? rawDraftId.trim()
      : undefined;
    if (!draftId) return { success: false, error: 'Missing required input: draft_id (string)' };

    const account = typeof rawAccount === 'string' && rawAccount.trim()
      ? rawAccount.trim()
      : undefined;
    if (!account) return { success: false, error: 'Missing required input: account (string)' };

    ctx.log.info({ draftId, account }, 'send-draft: fetching draft');

    // ------------------------------------------------------------------
    // Step 3: Fetch draft from Nylas DRAFTS folder
    // ------------------------------------------------------------------
    // The Nylas DRAFTS folder is the source of truth — no shadow PG registry needed.
    // We list all drafts and filter client-side by ID; Nylas doesn't support
    // a direct draft-by-ID lookup via the messages API.
    let drafts: Awaited<ReturnType<typeof ctx.outboundGateway.listEmailMessages>>;
    try {
      drafts = await ctx.outboundGateway.listEmailMessages({ folders: ['DRAFTS'] }, account);
    } catch (err) {
      ctx.log.error({ err, account }, 'send-draft: failed to fetch DRAFTS folder');
      return { success: false, error: 'Failed to fetch drafts folder' };
    }

    const draft = drafts.find((m) => m.id === draftId);
    if (!draft) {
      ctx.log.warn({ draftId, account }, 'send-draft: draft not found in DRAFTS folder');
      return { success: false, error: `Draft not found: ${draftId}` };
    }

    const recipient = draft.to[0]?.email;
    if (!recipient) {
      ctx.log.error({ draftId }, 'send-draft: draft has no recipient address');
      return { success: false, error: 'Draft has no recipient address' };
    }

    // ------------------------------------------------------------------
    // Step 4: Resolve reply threading
    // ------------------------------------------------------------------
    // If the draft belongs to an existing thread, look up the latest message
    // in that thread and pass its ID as replyToMessageId so Nylas threads the
    // outbound message correctly. Same pattern as email-adapter.sendOutboundReply().
    //
    // Thread lookup failure is non-fatal: the email still reaches the recipient;
    // only the In-Reply-To / References headers are missing.
    let replyToMessageId: string | undefined;
    if (draft.threadId) {
      try {
        const threadMessages = await ctx.outboundGateway.listEmailMessages(
          { threadId: draft.threadId, limit: 1 },
          account,
        );
        replyToMessageId = threadMessages[0]?.id;
      } catch (err) {
        ctx.log.warn(
          { err, draftId, threadId: draft.threadId },
          'send-draft: thread lookup failed — sending without replyToMessageId',
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 5: Send via gateway with humanApproved: true
    // ------------------------------------------------------------------
    // humanApproved: true skips the autonomy gate (Step 0) only — the CEO is
    // explicitly in the loop. Blocked-contact check and content filter run normally.
    ctx.log.info({ draftId, account, recipient }, 'send-draft: sending');

    let sendResult: Awaited<ReturnType<typeof ctx.outboundGateway.send>>;
    try {
      sendResult = await ctx.outboundGateway.send(
        {
          channel: 'email',
          accountId: account,
          to: recipient,
          subject: draft.subject,
          body: draft.body,
          replyToMessageId,
        },
        { humanApproved: true },
      );
    } catch (err) {
      ctx.log.error({ err, draftId, account }, 'send-draft: unexpected error during send');
      return { success: false, error: 'Failed to send draft' };
    }

    if (!sendResult.success) {
      ctx.log.warn(
        { draftId, account, reason: sendResult.blockedReason },
        'send-draft: gateway blocked the send',
      );
      return { success: false, error: sendResult.blockedReason ?? 'Send blocked by gateway' };
    }

    // ------------------------------------------------------------------
    // Step 6: Publish human.decision audit event
    // ------------------------------------------------------------------
    // Non-fatal: the message is already sent. If bus publish fails, log at error
    // so the missing audit trail is visible in alerting, but don't fail the skill.
    const senderId = typeof ctx.taskMetadata?.senderId === 'string'
      ? ctx.taskMetadata.senderId
      : 'unknown';
    const channelId = typeof ctx.taskMetadata?.channelId === 'string'
      ? ctx.taskMetadata.channelId
      : 'unknown';

    try {
      await ctx.bus.publish(
        'dispatch',
        createHumanDecision({
          decision: 'approve',
          deciderId: senderId,
          deciderChannel: channelId,
          // subjectEventId: the task event that drove the CEO's "send it" instruction.
          subjectEventId: ctx.taskEventId ?? '',
          subjectSummary: `CEO authorized send of draft '${draft.subject}' to ${recipient}`,
          contextShown: ['draft_id', 'draft_subject', 'draft_recipient'],
          // presentedAt: draft creation time as proxy for when the decision was presented.
          presentedAt: new Date(draft.date * 1000),
          decidedAt: new Date(),
          defaultAction: 'block',
          parentEventId: ctx.taskEventId ?? '',
        }),
      );
    } catch (err) {
      ctx.log.error(
        { err, draftId },
        'send-draft: failed to publish human.decision event — message was sent but audit event is missing',
      );
    }

    ctx.log.info(
      { draftId, messageId: sendResult.messageId, recipient },
      'send-draft: sent successfully',
    );

    return {
      success: true,
      data: {
        message_id: sendResult.messageId ?? '',
        to: recipient,
        subject: draft.subject,
      },
    };
  }
}
