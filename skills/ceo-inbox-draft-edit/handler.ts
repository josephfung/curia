import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, type NylasParticipant, type UpdateDraftOptions } from '../_shared/ceo-nylas-client.js';
import { markdownToHtml } from '../../src/channels/email/markdown-to-html.js';

const MAX_BODY_LENGTH = 50_000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Parse a `to`/`cc` input that may arrive as a single string or an array of
// strings. Returns the trimmed addresses, or an `{ error }` when the input is
// malformed (a non-string, or an array containing a non-string/blank entry).
//
// Malformed input MUST surface as an error rather than collapsing to an empty
// list: for `cc`, an empty list is a legitimate "clear the CC line" instruction,
// so silently turning `cc: 123` or `cc: [1, 2]` into `[]` would wipe the draft's
// existing recipients without the caller intending it. (CodeAnt #1003)
function parseEmailField(raw: unknown): { emails: string[] } | { error: string } {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return { emails: trimmed ? [trimmed] : [] };
  }
  if (Array.isArray(raw)) {
    const emails: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) {
        return { error: 'must be a string or an array of non-empty email strings' };
      }
      emails.push(entry.trim());
    }
    return { emails };
  }
  return { error: 'must be a string or an array of non-empty email strings' };
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

    // Detect which fields the caller wants to change by KEY PRESENCE, not by type.
    // Only `to`/`cc`/`subject`/`body` keys that are actually present become part of
    // the update — we never send an omitted field, so a partial edit can't blank out
    // the rest of the draft. Presence (not `typeof === 'string'`) is deliberate: a
    // malformed value like `subject: 123` must be rejected, not silently skipped, or
    // the caller gets a success response that misrepresents what was applied.
    const hasTo = input.to !== undefined;
    const hasCc = input.cc !== undefined;
    const hasSubject = input.subject !== undefined;
    const hasBody = input.body !== undefined;

    if (!hasTo && !hasCc && !hasSubject && !hasBody) {
      return {
        success: false,
        error: 'At least one of to, cc, subject, or body must be provided to update the draft',
      };
    }

    const updates: UpdateDraftOptions = {};

    if (hasTo) {
      const parsed = parseEmailField(input.to);
      if ('error' in parsed) {
        return { success: false, error: `to ${parsed.error}` };
      }
      if (parsed.emails.length === 0) {
        // Unlike cc, a draft can't have an empty `to` — that would leave it unsendable.
        return { success: false, error: 'to was provided but contained no email addresses' };
      }
      for (const email of parsed.emails) {
        if (!EMAIL_REGEX.test(email)) {
          return { success: false, error: `Invalid email address in to: ${email}` };
        }
      }
      updates.to = parsed.emails.map((email): NylasParticipant => ({ email }));
    }

    if (hasCc) {
      const parsed = parseEmailField(input.cc);
      if ('error' in parsed) {
        return { success: false, error: `cc ${parsed.error}` };
      }
      for (const email of parsed.emails) {
        if (!EMAIL_REGEX.test(email)) {
          return { success: false, error: `Invalid email address in cc: ${email}` };
        }
      }
      // An explicit empty cc (`""` or `[]`) clears the CC list — a legitimate edit.
      // Malformed cc was already rejected above, so this can only be an
      // intentional clear, never a silent wipe from bad input.
      updates.cc = parsed.emails.map((email): NylasParticipant => ({ email }));
    }

    if (hasSubject) {
      // Reject non-string or whitespace-only subjects. A blank subject would
      // silently clear the draft's existing subject line on an accidental input.
      if (typeof input.subject !== 'string' || !input.subject.trim()) {
        return { success: false, error: 'subject must be a non-empty string' };
      }
      updates.subject = input.subject.trim();
    }

    if (hasBody) {
      if (typeof input.body !== 'string' || !input.body.trim()) {
        return { success: false, error: 'body must be a non-empty string' };
      }
      const body = input.body.trim();
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
