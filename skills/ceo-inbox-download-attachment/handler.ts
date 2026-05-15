// handler.ts — ceo-inbox-download-attachment skill.
//
// Downloads an attachment from the CEO's personal email inbox and returns the
// file content as a base64 string ready for file-parse.
//
// Workflow:
//   1. Fetch the full message to verify the attachment exists and check size.
//   2. Enforce 10 MB cap — avoids excessive memory use for large files.
//   3. Download raw bytes via CeoNylasClient.downloadAttachment().
//   4. Return base64-encoded content + metadata.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export class CeoInboxDownloadAttachmentHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const apiKey = ctx.secret('nylas_api_key');
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const attachmentId =
      typeof input.attachment_id === 'string' ? input.attachment_id.trim() : '';
    const messageId =
      typeof input.message_id === 'string' ? input.message_id.trim() : '';

    if (!attachmentId) {
      return { success: false, error: 'attachment_id is required' };
    }
    if (!messageId) {
      return { success: false, error: 'message_id is required' };
    }

    // Fetch the full message to verify the attachment exists and get its metadata.
    let msg: Awaited<ReturnType<typeof client.getMessage>>;
    try {
      msg = await client.getMessage(messageId);
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-download-attachment: failed to fetch message');
      return { success: false, error: 'Failed to fetch message' };
    }

    const attachment = msg.attachments.find((a) => a.id === attachmentId);
    if (!attachment) {
      return {
        success: false,
        error: `Attachment ${attachmentId} not found on message ${messageId}`,
      };
    }

    if (attachment.size > MAX_DOWNLOAD_BYTES) {
      const sizeMB = (attachment.size / (1024 * 1024)).toFixed(1);
      return {
        success: false,
        error: `Attachment "${attachment.filename}" is ${sizeMB} MB — exceeds the 10 MB download limit`,
      };
    }

    ctx.log.info(
      { attachmentId, messageId, filename: attachment.filename, declaredSize: attachment.size },
      'ceo-inbox-download-attachment: downloading',
    );

    let buffer: Buffer;
    try {
      buffer = await client.downloadAttachment(attachmentId, messageId);
    } catch (err) {
      ctx.log.error(
        { err, attachmentId, messageId },
        'ceo-inbox-download-attachment: download failed',
      );
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Failed to download attachment "${attachment.filename}": ${detail}`,
      };
    }

    // Post-download size check — catches cases where the declared size was 0 (missing) or incorrect.
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
      ctx.log.warn(
        { attachmentId, messageId, actualBytes: buffer.length, declaredSize: attachment.size },
        'ceo-inbox-download-attachment: actual download size exceeded limit',
      );
      return {
        success: false,
        error: `Attachment "${attachment.filename}" actual size ${sizeMB} MB — exceeds the 10 MB download limit`,
      };
    }

    return {
      success: true,
      data: {
        content_base64: buffer.toString('base64'),
        filename: attachment.filename,
        content_type: attachment.contentType,
        size: buffer.length,
      },
    };
  }
}
