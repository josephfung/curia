import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, type NylasParticipant, type DraftAttachment } from '../_shared/ceo-nylas-client.js';
import { markdownToHtml } from '../../src/format/markdown-to-html.js';
import { parseAttachmentInputs } from '../_shared/parse-attachments.js';
import { readAttachmentFiles, MAX_ATTACHMENT_BYTES } from '../../src/skills/_shared/read-attachments.js';
import { captureDraftSnapshot } from '../_shared/voice-learning-capture.js';

const MAX_BODY_LENGTH = 50_000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class CeoInboxDraftComposeHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    let apiKey: string;
    let grantId: string;
    try {
      apiKey = ctx.secret('nylas_api_key');
      grantId = ctx.secret('ceo_nylas_grant_id');
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-draft-compose: required secret not available');
      return { success: false, error: 'CEO inbox is not configured (missing credentials)' };
    }

    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    // Normalise to: accept a single string or an array of strings.
    const rawTo = input.to;
    const toStrings: string[] = Array.isArray(rawTo)
      ? rawTo.filter((v) => typeof v === 'string' && v.trim()).map((v) => (v as string).trim())
      : typeof rawTo === 'string' && rawTo.trim()
        ? [rawTo.trim()]
        : [];

    const rawCc = input.cc;
    const ccStrings: string[] = Array.isArray(rawCc)
      ? rawCc.filter((v) => typeof v === 'string' && v.trim()).map((v) => (v as string).trim())
      : typeof rawCc === 'string' && rawCc.trim()
        ? [rawCc.trim()]
        : [];

    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    const body = typeof input.body === 'string' ? input.body.trim() : '';

    if (toStrings.length === 0) {
      return { success: false, error: 'to is required (non-empty array of email addresses)' };
    }
    if (!subject) {
      return { success: false, error: 'subject is required' };
    }
    if (!body) {
      return { success: false, error: 'body is required' };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    for (const email of toStrings) {
      if (!EMAIL_REGEX.test(email)) {
        return { success: false, error: `Invalid email address in to: ${email}` };
      }
    }
    for (const email of ccStrings) {
      if (!EMAIL_REGEX.test(email)) {
        return { success: false, error: `Invalid email address in cc: ${email}` };
      }
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

    const to: NylasParticipant[] = toStrings.map((email) => ({ email }));
    const cc: NylasParticipant[] = ccStrings.map((email) => ({ email }));

    ctx.log.info(
      { toCount: to.length, ccCount: cc.length, subject, attachmentCount: attachments.length },
      'ceo-inbox-draft-compose: creating compose draft',
    );

    try {
      const htmlBody = markdownToHtml(body, { wrap: true });

      const draft = await client.createDraft({
        subject,
        body: htmlBody,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });

      ctx.log.info(
        { draftId: draft.id, subject: draft.subject },
        'ceo-inbox-draft-compose: draft created',
      );

      // Best-effort voice-learning snapshot — fire-and-forget so working-document I/O
      // never adds latency to draft creation (#1421). captureDraftSnapshot logs its own
      // failures and never rejects; the .catch guards against an unexpected throw becoming
      // an unhandled rejection.
      void captureDraftSnapshot(ctx, {
        draftId: draft.id,
        threadId: draft.threadId,
        subject: draft.subject,
        to: draft.to,
        cc: draft.cc,
        body,
      }).catch((err) =>
        ctx.log.error({ err }, 'ceo-inbox-draft-compose: voice snapshot capture rejected'),
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
        { err, subject },
        'ceo-inbox-draft-compose: Nylas API call failed',
      );
      return { success: false, error: 'Failed to create draft in CEO inbox' };
    }
  }
}
