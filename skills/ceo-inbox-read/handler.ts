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

    if (!messageId) {
      return { success: false, error: 'message_id is required' };
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
