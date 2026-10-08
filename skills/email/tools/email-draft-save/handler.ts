// handler.ts — email-draft-save skill implementation.
//
// Saves a draft email without sending it. Routes via OutboundGateway.createEmailDraft(),
// which runs the blocked-contact check and converts markdown to HTML.
//
// Use this for the NEEDS DRAFT triage category: coordinator writes the draft,
// the principal reviews and sends it from their email client.
//
// `to` is a contact reference (#2041, ADR-047): a contact ID or "principal", with an
// optional #label hint, resolved by the gateway to a verified address. A draft is
// never addressed to a typed address, so send-draft never sends to one.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { buildReplyQuote } from '../../../../src/skills/_shared/reply-quote.js';
import { parseAttachmentInputs } from '../../../_shared/parse-attachments.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmailDraftSaveHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-draft-save requires outboundGateway (capabilities: ["outboundGateway"])' };
    }

    // Handlers must never throw — destructuring a non-object ctx.input would.
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const { to: rawTo, subject, body, account, reply_to_message_id, attachments: attachmentsRaw } = input as {
      to?: string;
      subject?: string;
      body?: string;
      account?: string;
      reply_to_message_id?: string;
      attachments?: unknown;
    };

    const attachmentsParsed = parseAttachmentInputs(attachmentsRaw);
    if (typeof attachmentsParsed === 'string') {
      return { success: false, error: attachmentsParsed };
    }

    const to = typeof rawTo === 'string' ? rawTo.trim() : undefined;
    if (!to) return { success: false, error: 'Missing required input: to (a contact ID, or "principal" for the principal)' };
    if (to.includes(',')) return { success: false, error: 'email-draft-save takes a single recipient in to.' };
    if (!subject || typeof subject !== 'string') return { success: false, error: 'Missing required input: subject (string)' };
    if (!body || typeof body !== 'string') return { success: false, error: 'Missing required input: body (string)' };

    const accountId = typeof account === 'string' && account.trim() ? account.trim() : undefined;
    const replyToMessageId = typeof reply_to_message_id === 'string' && reply_to_message_id.trim()
      ? reply_to_message_id.trim()
      : undefined;

    // Resolve the reference (#2041). Every failure is closed: no draft is saved.
    const resolved = await ctx.outboundGateway.resolveRecipientReference('email', to, { field: 'to' });
    if (!resolved.ok) return { success: false, error: resolved.error };
    if (!EMAIL_REGEX.test(resolved.identifier)) {
      // A stored identity Nylas cannot address: a data defect. Never echo the ID (it may be the principal's).
      ctx.log.warn({ field: 'to' }, 'email-draft-save: verified email identity is not a valid address — refusing (#2041)');
      return {
        success: false,
        error: "The to contact's verified email identity is not a valid address, so no draft was saved. It needs correcting in Contacts.",
      };
    }
    const address = resolved.identifier;

    // Warn when a draft omits the account param — the draft will silently land in
    // the primary (Curia) account, which is almost never what the principal intended.
    if (!accountId) {
      ctx.log.warn(
        { to: address, subject },
        'email-draft-save: no account specified — '
        + 'draft will land in the primary (agent) account. '
        + 'Did the coordinator mean to pass the principal account name?',
      );
    }

    ctx.log.info({ to: address, subject, accountId, replyToMessageId }, 'email-draft-save: saving draft');

    // When replying, fetch the original message and append a quoted copy below
    // the reply body. Both the fetch and the formatting are non-fatal — if either
    // fails, proceed with the unquoted body and log a warning at the correct step.
    let quotedBody = body;
    if (replyToMessageId) {
      let original: Awaited<ReturnType<typeof ctx.outboundGateway.getEmailMessage>> | undefined;
      try {
        original = await ctx.outboundGateway.getEmailMessage(replyToMessageId, accountId);
      } catch (err) {
        ctx.log.warn(
          { err, replyToMessageId },
          'email-draft-save: failed to fetch original message for quote — proceeding without quote',
        );
      }
      if (original !== undefined) {
        try {
          quotedBody = body + buildReplyQuote(original, ctx.timezone);
        } catch (err) {
          ctx.log.warn(
            { err, replyToMessageId },
            'email-draft-save: failed to build reply quote — proceeding without quote',
          );
        }
      }
    }

    let result: Awaited<ReturnType<typeof ctx.outboundGateway.createEmailDraft>>;
    try {
      result = await ctx.outboundGateway.createEmailDraft({
        channel: 'email',
        to: address,
        subject,
        body: quotedBody,
        accountId,
        replyToMessageId,
        ...(attachmentsParsed.length > 0 ? { attachments: attachmentsParsed } : {}),
      });
    } catch (err) {
      ctx.log.error({ err, to: address, accountId }, 'email-draft-save: unexpected error saving draft');
      return { success: false, error: 'Failed to save draft' };
    }

    if (!result.success) {
      ctx.log.error({ to: address, accountId, reason: result.blockedReason }, 'email-draft-save: gateway rejected draft');
      return { success: false, error: result.blockedReason ?? 'Failed to save draft' };
    }

    // OutboundDraftResult.draftId is typed optional; guard so we never violate the
    // declared `draft_id: string` output contract by emitting `undefined`.
    if (!result.draftId) {
      ctx.log.error({ to: address, accountId }, 'email-draft-save: gateway returned success without draftId');
      return { success: false, error: 'Failed to save draft' };
    }

    ctx.log.info({ draftId: result.draftId, to: address, accountId }, 'email-draft-save: draft saved');

    return {
      success: true,
      data: {
        draft_id: result.draftId,
        to_identity: resolved.identityName,
        // Only a UUID the agent passed is echoed; the principal's ID stays out (spec 09).
        ...(resolved.kind === 'contact' ? { contact_id: resolved.contactId } : {}),
      },
    };
  }
}
