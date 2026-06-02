import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, type NylasParticipant } from '../_shared/ceo-nylas-client.js';
import { markdownToHtml } from '../../src/channels/email/markdown-to-html.js';

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

    const to: NylasParticipant[] = toStrings.map((email) => ({ email }));
    const cc: NylasParticipant[] = ccStrings.map((email) => ({ email }));

    ctx.log.info(
      { toCount: to.length, ccCount: cc.length, subject },
      'ceo-inbox-draft-compose: creating compose draft',
    );

    let htmlBody: string;
    try {
      htmlBody = markdownToHtml(body);
    } catch (err) {
      ctx.log.error({ err, subject }, 'ceo-inbox-draft-compose: failed to convert body to HTML');
      return { success: false, error: 'Failed to convert email body to HTML' };
    }

    try {
      const draft = await client.createDraft({
        subject,
        body: htmlBody,
        to,
        ...(cc.length > 0 ? { cc } : {}),
      });

      ctx.log.info(
        { draftId: draft.id, subject: draft.subject },
        'ceo-inbox-draft-compose: draft created',
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
