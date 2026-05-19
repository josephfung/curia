// handler.ts — email-download-attachment skill.
//
// Downloads an email attachment by Nylas attachment ID and returns the file
// content as a base64 string ready for file-parse.
//
// Workflow:
//   1. Fetch the message to verify the attachment exists and check its size.
//   2. Enforce a 10 MB cap to prevent large files from consuming excessive memory.
//   3. Download via outboundGateway.downloadEmailAttachment().
//   4. Return base64-encoded content plus metadata.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { MAX_TEMP_FILE_BYTES } from '../../src/skills/temp-file-store.js';

export class EmailDownloadAttachmentHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-download-attachment requires outboundGateway (capabilities: ["outboundGateway"])',
      };
    }

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const { attachment_id: rawAttId, message_id: rawMsgId, account } = input as {
      attachment_id?: string;
      message_id?: string;
      account?: string;
    };

    const attachmentId = typeof rawAttId === 'string' ? rawAttId.trim() : '';
    const messageId = typeof rawMsgId === 'string' ? rawMsgId.trim() : '';
    const accountId =
      typeof account === 'string' && account.trim() ? account.trim() : undefined;

    if (!attachmentId) {
      return { success: false, error: 'Missing required input: attachment_id' };
    }
    if (!messageId) {
      return { success: false, error: 'Missing required input: message_id' };
    }

    // Fetch the message to verify the attachment ID and check its declared size.
    // This also serves as an authorization check — the caller must know both IDs.
    let message: Awaited<ReturnType<typeof ctx.outboundGateway.getEmailMessage>>;
    try {
      message = await ctx.outboundGateway.getEmailMessage(messageId, accountId);
    } catch (err) {
      ctx.log.error({ err, messageId }, 'email-download-attachment: failed to fetch message');
      return { success: false, error: 'Failed to fetch message to verify attachment' };
    }

    const attachment = message.attachments.find((a) => a.id === attachmentId);
    if (!attachment) {
      return {
        success: false,
        error: `Attachment ${attachmentId} not found on message ${messageId}`,
      };
    }

    if (attachment.size > MAX_TEMP_FILE_BYTES) {
      const sizeMB = (attachment.size / (1024 * 1024)).toFixed(1);
      return {
        success: false,
        error: `Attachment "${attachment.filename}" is ${sizeMB} MB — exceeds the 10 MB download limit`,
      };
    }

    ctx.log.info(
      { attachmentId, messageId, filename: attachment.filename, declaredSize: attachment.size },
      'email-download-attachment: downloading',
    );

    let buffer: Buffer;
    try {
      buffer = await ctx.outboundGateway.downloadEmailAttachment(
        attachmentId,
        messageId,
        accountId,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, attachmentId, messageId }, 'email-download-attachment: download failed');
      return { success: false, error: `Failed to download attachment "${attachment.filename}": ${detail}` };
    }

    // Post-download size check — catches cases where the declared size was 0 (missing from API)
    // or where the actual content was larger than declared.
    if (buffer.length > MAX_TEMP_FILE_BYTES) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
      ctx.log.warn(
        { attachmentId, messageId, actualBytes: buffer.length, declaredSize: attachment.size },
        'email-download-attachment: actual download size exceeded limit',
      );
      return {
        success: false,
        error: `Attachment "${attachment.filename}" actual size ${sizeMB} MB — exceeds the 10 MB download limit`,
      };
    }

    // Write to temp storage so the agent can pass a file:// URL to Drive upload.
    // The workspace-mcp create_drive_file tool reads raw bytes from disk via
    // fileUrl, avoiding the base64 corruption that occurs via the content param.
    let tempFileUrl: string | undefined;
    if (ctx.writeTempFile) {
      try {
        tempFileUrl = await ctx.writeTempFile(buffer, attachment.filename);
      } catch (err) {
        // Non-fatal — the agent can still use content_base64 for parsing.
        // Log the failure so operators know temp storage is degraded.
        ctx.log.warn({ err, filename: attachment.filename }, 'email-download-attachment: writeTempFile failed');
      }
    }

    // When temp_file_url is available, omit content_base64 to avoid blowing the
    // skill output size limit. A 160KB image produces ~214KB of base64 which
    // exceeds the ~200K truncation threshold, destroying the JSON and hiding
    // temp_file_url from the agent. The temp file has the raw bytes for both
    // Drive uploads (via fileUrl) and file-parse (via content_base64 on a
    // re-download if needed). When temp storage is unavailable, content_base64
    // is the only way to access the file so it must be included.
    return {
      success: true,
      data: {
        temp_file_url: tempFileUrl,
        filename: attachment.filename,
        content_type: attachment.contentType,
        size: buffer.length,
        ...(tempFileUrl ? {} : { content_base64: buffer.toString('base64') }),
      },
    };
  }
}
