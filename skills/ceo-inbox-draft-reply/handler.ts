import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, type NylasParticipant, type DraftAttachment } from '../_shared/ceo-nylas-client.js';
import { buildReplyQuote } from '../../src/skills/_shared/reply-quote.js';
import { markdownToHtml } from '../../src/channels/email/markdown-to-html.js';
import { parseAttachmentInputs } from '../_shared/parse-attachments.js';
import { readAttachmentFiles } from '../../src/skills/_shared/read-attachments.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class CeoInboxDraftReplyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    let apiKey: string;
    let grantId: string;
    let selfEmail: string;
    try {
      apiKey = ctx.secret('nylas_api_key');
      grantId = ctx.secret('ceo_nylas_grant_id');
      selfEmail = ctx.secret('ceo_self_email').toLowerCase();
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-draft-reply: required secret not available');
      return { success: false, error: 'CEO inbox is not configured (missing credentials)' };
    }

    // Guard: selfEmail must be set — without it we cannot filter the CEO's own address
    // from reply recipients, which would cause self-addressed drafts.
    if (!selfEmail) {
      ctx.log.error({}, 'ceo-inbox-draft-reply: ceo_self_email secret is empty — self-filter disabled');
      return { success: false, error: 'Configuration error: ceo_self_email secret is not set' };
    }

    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const replyToMessageId =
      typeof input.reply_to_message_id === 'string' ? input.reply_to_message_id.trim() : '';
    const body =
      typeof input.body === 'string' ? input.body.trim() : '';

    if (!replyToMessageId) {
      return { success: false, error: 'reply_to_message_id is required' };
    }
    if (!body) {
      return { success: false, error: 'body is required' };
    }

    const attachmentInputsParsed = parseAttachmentInputs(input.attachments);
    if (typeof attachmentInputsParsed === 'string') {
      return { success: false, error: attachmentInputsParsed };
    }

    let attachments: DraftAttachment[] = [];
    if (attachmentInputsParsed.length > 0) {
      try {
        attachments = await readAttachmentFiles(attachmentInputsParsed, MAX_ATTACHMENT_BYTES);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Attachment error: ${message}` };
      }
    }

    ctx.log.info(
      { replyToMessageId, bodyLength: body.length, attachmentCount: attachments.length },
      'ceo-inbox-draft-reply: creating reply-all draft',
    );

    try {
      // Fetch the original message to compute reply-all recipients.
      // Reply-all: original sender → to, original to + cc (minus self) → cc.
      const original = await client.getMessage(replyToMessageId);

      // Guard: without a sender we have no valid To address — fail rather than
      // silently creating a draft addressed to the placeholder 'unknown'.
      if (original.from.length === 0) {
        ctx.log.error(
          { replyToMessageId },
          'ceo-inbox-draft-reply: original message has no sender address; cannot create reply draft',
        );
        return { success: false, error: 'Original message has no sender address; cannot create a reply draft' };
      }

      // To: the original sender
      const to: NylasParticipant[] = original.from;

      // CC: everyone from original to + cc, minus the CEO's own address
      // and minus the original sender (already in "to")
      const senderEmails = new Set(original.from.map((p) => p.email.toLowerCase()));
      const ccCandidates = [...original.to, ...original.cc].filter((p) => {
        const lower = p.email.toLowerCase();
        return lower !== selfEmail && !senderEmails.has(lower);
      });

      // Deduplicate cc by email (case-insensitive)
      const seenCc = new Set<string>();
      const cc = ccCandidates.filter((p) => {
        const lower = p.email.toLowerCase();
        if (seenCc.has(lower)) return false;
        seenCc.add(lower);
        return true;
      });

      // Nylas v3 does not auto-populate the subject from reply_to_message_id —
      // we must set it explicitly or the draft lands with a blank subject.
      // Strip existing Re: prefix (case-insensitive) before prepending our own to
      // avoid "Re: RE: Re: ..." chains — matches the pattern used by email-reply
      // and email-adapter.
      const replySubject = `Re: ${original.subject.replace(/^Re:\s*/i, '')}`;

      ctx.log.info(
        { replyToMessageId, toCount: to.length, ccCount: cc.length, replySubject },
        'ceo-inbox-draft-reply: computed reply-all recipients',
      );

      // Convert the LLM-authored markdown body to HTML before combining with the
      // quote — this path bypasses the gateway, so markdownToHtml is not called there.
      // Formatting is non-fatal — a failure must not block draft creation.
      const htmlBody = markdownToHtml(body);
      let draftBody = htmlBody;
      try {
        const htmlQuote = buildReplyQuote(original, ctx.timezone, { format: 'html' });
        // Apply the same size guard used by the other reply callers — a long quoted
        // thread should not produce an oversized Nylas draft payload.
        if (htmlBody.length + htmlQuote.length <= 50_000) {
          draftBody = htmlBody + htmlQuote;
        }
      } catch (err) {
        ctx.log.warn(
          { err, replyToMessageId },
          'ceo-inbox-draft-reply: failed to build reply quote — proceeding without quote',
        );
      }

      const draft = await client.createDraftReply({
        replyToMessageId,
        subject: replySubject,
        body: draftBody,
        to,
        cc,
        ...(attachments.length > 0 ? { attachments } : {}),
      });

      ctx.log.info(
        { draftId: draft.id, subject: draft.subject },
        'ceo-inbox-draft-reply: draft created',
      );

      return {
        success: true,
        data: {
          draft_id: draft.id,
          subject: draft.subject,
          to: draft.to,
          cc: draft.cc,
        },
      };
    } catch (err) {
      ctx.log.error(
        { err, replyToMessageId },
        'ceo-inbox-draft-reply: failed to create draft',
      );
      return { success: false, error: 'Failed to create draft reply in CEO inbox' };
    }
  }
}
