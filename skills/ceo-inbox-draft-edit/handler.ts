import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, type NylasParticipant, type UpdateDraftOptions } from '../_shared/ceo-nylas-client.js';
import { markdownToHtml } from '../../src/channels/email/markdown-to-html.js';

const MAX_BODY_LENGTH = 50_000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Normalise a `to`/`cc` input that may arrive as a single string or an array.
function toEmailList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v) => typeof v === 'string' && v.trim()).map((v) => (v as string).trim());
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

/**
 * Update an existing draft in the CEO's mailbox (issue #1000). Lets the agent
 * fix a wrong recipient, subject, or body on a draft that was already created —
 * the capability that was missing, which left bad drafts uneditable.
 */
export class CeoInboxDraftEditHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    let apiKey: string;
    let grantId: string;
    try {
      apiKey = ctx.secret('nylas_api_key');
      grantId = ctx.secret('ceo_nylas_grant_id');
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-draft-edit: required secret not available');
      return { success: false, error: 'CEO inbox is not configured (missing credentials)' };
    }

    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const draftId = typeof input.draft_id === 'string' ? input.draft_id.trim() : '';
    if (!draftId) {
      return { success: false, error: 'draft_id is required' };
    }

    // Detect which fields the caller wants to change. Only `to`/`cc`/`subject`/
    // `body` keys that are actually present become part of the update — we never
    // send an omitted field, so a partial edit can't blank out the rest of the draft.
    const hasTo = input.to !== undefined;
    const hasCc = input.cc !== undefined;
    const hasSubject = typeof input.subject === 'string';
    const hasBody = typeof input.body === 'string';

    if (!hasTo && !hasCc && !hasSubject && !hasBody) {
      return {
        success: false,
        error: 'At least one of to, cc, subject, or body must be provided to update the draft',
      };
    }

    const updates: UpdateDraftOptions = {};

    if (hasTo) {
      const toStrings = toEmailList(input.to);
      if (toStrings.length === 0) {
        return { success: false, error: 'to was provided but contained no valid email addresses' };
      }
      for (const email of toStrings) {
        if (!EMAIL_REGEX.test(email)) {
          return { success: false, error: `Invalid email address in to: ${email}` };
        }
      }
      updates.to = toStrings.map((email): NylasParticipant => ({ email }));
    }

    if (hasCc) {
      const ccStrings = toEmailList(input.cc);
      for (const email of ccStrings) {
        if (!EMAIL_REGEX.test(email)) {
          return { success: false, error: `Invalid email address in cc: ${email}` };
        }
      }
      // An explicit empty cc clears the CC list — a legitimate edit.
      updates.cc = ccStrings.map((email): NylasParticipant => ({ email }));
    }

    if (hasSubject) {
      updates.subject = (input.subject as string).trim();
    }

    if (hasBody) {
      const body = (input.body as string).trim();
      if (body.length > MAX_BODY_LENGTH) {
        return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
      }
      try {
        updates.body = markdownToHtml(body);
      } catch (err) {
        ctx.log.error({ err, draftId }, 'ceo-inbox-draft-edit: failed to convert body to HTML');
        return { success: false, error: 'Failed to convert email body to HTML' };
      }
    }

    ctx.log.info(
      {
        draftId,
        updatedFields: Object.keys(updates),
      },
      'ceo-inbox-draft-edit: updating draft',
    );

    try {
      const draft = await client.updateDraft(draftId, updates);
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
      ctx.log.error({ err, draftId }, 'ceo-inbox-draft-edit: Nylas API call failed');
      return { success: false, error: 'Failed to update draft in CEO inbox' };
    }
  }
}
