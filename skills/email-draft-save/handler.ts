// handler.ts — email-draft-save skill implementation.
//
// Saves a draft email without sending it. Routes via OutboundGateway.createEmailDraft(),
// which runs the blocked-contact check and converts markdown to HTML.
//
// Use this for the NEEDS DRAFT triage category: coordinator writes the draft,
// the CEO reviews and sends it from their email client.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { generateShortRef } from '../../src/autonomy/approval-trigger.js';

export class EmailDraftSaveHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-draft-save requires outboundGateway (capabilities: ["outboundGateway"])' };
    }

    // Handlers must never throw — destructuring a non-object ctx.input would.
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const { to: rawTo, subject, body, account, reply_to_message_id, triage_classification } = input as {
      to?: string;
      subject?: string;
      body?: string;
      account?: string;
      reply_to_message_id?: string;
      triage_classification?: string;
    };

    const to = typeof rawTo === 'string' ? rawTo.trim() : undefined;
    if (!to) return { success: false, error: 'Missing required input: to (string)' };
    if (!subject || typeof subject !== 'string') return { success: false, error: 'Missing required input: subject (string)' };
    if (!body || typeof body !== 'string') return { success: false, error: 'Missing required input: body (string)' };

    // Observation mode guard — the coordinator must only save drafts for NEEDS DRAFT emails.
    // Calling email-draft-save for NOISE or LEAVE FOR CEO (or without declaring a classification)
    // is a model slip: block it hard so the error is auditable rather than silently creating
    // a draft the CEO did not request. Outside observation mode, triage_classification is ignored.
    // Treat whitespace-only strings as absent — mirrors the pattern used for accountId and
    // replyToMessageId below, and ensures the error message emits 'absent' rather than '""'.
    const triageClassification =
      typeof triage_classification === 'string' && triage_classification.trim()
        ? triage_classification.trim()
        : undefined;
    if (ctx.taskMetadata?.observationMode === true && triageClassification !== 'NEEDS DRAFT') {
      ctx.log.warn(
        { triageClassification: triageClassification ?? '(absent)' },
        'email-draft-save: blocked in observation mode — triage_classification must be "NEEDS DRAFT"',
      );
      return {
        success: false,
        error: `email-draft-save blocked in observation mode: triage_classification must be "NEEDS DRAFT" (got: ${triageClassification !== undefined ? `"${triageClassification}"` : '(field absent)'})`,
      };
    }

    const accountId = typeof account === 'string' && account.trim() ? account.trim() : undefined;
    const replyToMessageId = typeof reply_to_message_id === 'string' && reply_to_message_id.trim()
      ? reply_to_message_id.trim()
      : undefined;

    // Warn when a non-observation-mode draft omits the account param. In practice this
    // means a CEO-initiated request ("draft this from me") fell through without the
    // coordinator specifying which account to target — the draft will silently land in
    // the primary (Curia) account, which is almost never what the CEO intended.
    if (!accountId && ctx.taskMetadata?.observationMode !== true) {
      ctx.log.warn(
        { to, subject },
        'email-draft-save: no account specified for non-observation-mode draft — '
        + 'draft will land in the primary (agent) account. '
        + 'Did the coordinator mean to pass the CEO account name?',
      );
    }

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

    // Track observation-mode drafts in action_log for pending-actions-digest.
    //
    // When the coordinator creates a draft in observation mode, the CEO needs to
    // know it exists so they can approve (send) or discard it. Writing a
    // pending_approval row here surfaces the draft in the next digest and
    // makes it reachable via the send-draft skill using the shortRef.
    //
    // We guard on all three prerequisites — missing any one means we either
    // aren't in obs mode (no tracking needed) or can't form a valid row.
    // Failures are non-fatal: a failed audit write must not block the draft.
    if (ctx.taskMetadata?.observationMode === true && ctx.actionLogRepo && ctx.taskEventId) {
      const recipientEmail = to;
      try {
        const shortRef = generateShortRef();
        const description = `Draft reply to ${recipientEmail}${subject ? ` — "${subject}"` : ''} (${accountId ?? 'default'}). Use send-draft to approve.`;

        await ctx.actionLogRepo.insert({
          taskId: ctx.taskEventId,
          // conversationId is not surfaced on SkillContext — omit rather than pass null
          skillName: 'email-draft-save',
          actionRisk: 'medium',
          outcome: 'pending_approval',
          shortRef,
          description,
          payload: {
            source: 'observation_mode',
            draftId: result.draftId,
            accountId,
            recipientEmail,
            subject,
          },
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        });

        ctx.log.info(
          { draftId: result.draftId, shortRef, taskId: ctx.taskEventId },
          'email-draft-save: observation-mode draft tracked in action_log',
        );
      } catch (err) {
        // Non-fatal — the draft was already created successfully. The coordinator
        // and CEO can still find it via their email client; the digest just won't
        // list it. Log at error (not warn) so the missing digest entry is visible in
        // alerting and can be investigated before the CEO misses an approval opportunity.
        ctx.log.error(
          { err, draftId: result.draftId, taskId: ctx.taskEventId },
          'email-draft-save: failed to write action_log row for observation-mode draft — draft saved but will not appear in pending-actions-digest',
        );
      }
    }

    return { success: true, data: { draft_id: result.draftId } };
  }
}
