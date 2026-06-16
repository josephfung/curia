import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, htmlToPlainText } from '../_shared/ceo-nylas-client.js';

export class CeoInboxReadHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const apiKey = ctx.secret('nylas_api_key');
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const messageId =
      typeof input.message_id === 'string' ? input.message_id.trim() : '';
    const draftId =
      typeof input.draft_id === 'string' ? input.draft_id.trim() : '';

    if (!messageId && !draftId) {
      return { success: false, error: 'message_id or draft_id is required' };
    }
    // Reject ambiguous calls rather than silently picking one — a draft and a
    // message are different resources, and guessing could read the wrong one.
    if (messageId && draftId) {
      return { success: false, error: 'Provide exactly one of message_id or draft_id, not both' };
    }

    // ── Draft path (issue #1000) ─────────────────────────────────────────────
    //
    // Drafts are a separate Nylas resource. Reading one returns its full body so
    // the agent can review the current content before calling ceo-inbox-draft-edit
    // (the find → read → edit workflow). List/search only return draft summaries.
    if (draftId) {
      ctx.log.info({ draftId }, 'ceo-inbox-read: fetching draft');
      let draft: Awaited<ReturnType<typeof client.getDraft>>;
      try {
        draft = await client.getDraft(draftId);
      } catch (err) {
        ctx.log.error({ err, draftId }, 'ceo-inbox-read: failed to fetch draft');
        return { success: false, error: 'Failed to read CEO inbox draft' };
      }
      return {
        success: true,
        data: {
          id: draft.id,
          threadId: draft.threadId,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          body_plain: htmlToPlainText(draft.body),
          body_html: draft.body,
          date: draft.date,
          // Flag the resource type so the agent knows this is an editable draft
          // (pass id to ceo-inbox-draft-edit), not a received message.
          is_draft: true,
        },
      };
    }

    ctx.log.info({ messageId }, 'ceo-inbox-read: fetching message');

    // Only getMessage() can fail with a Nylas API error — narrow the try-catch to just that call.
    let msg: Awaited<ReturnType<typeof client.getMessage>>;
    try {
      msg = await client.getMessage(messageId);
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-read: failed to fetch message');
      return { success: false, error: 'Failed to read CEO inbox message' };
    }

    // All formatting below is pure computation — no async I/O, no realistic throw path.
    const attachmentSummary =
      msg.attachments.length > 0
        ? `\n\n[Attachments: ${msg.attachments.map((a) => `${a.filename} (${formatFileSize(a.size)})`).join(', ')}]`
        : '';

    return {
      success: true,
      data: {
        id: msg.id,
        threadId: msg.threadId,
        from: msg.from,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        body_plain: htmlToPlainText(msg.body) + attachmentSummary,
        body_html: msg.body,
        date: msg.date,
        labels: msg.labels,
        attachments: msg.attachments,
      },
    };
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}
