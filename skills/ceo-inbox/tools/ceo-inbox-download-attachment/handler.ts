// handler.ts — ceo-inbox-download-attachment skill.
//
// Downloads an attachment from the principal's personal email inbox and returns the
// file content as a base64 string ready for file-parse.
//
// Workflow:
//   1. Fetch the full message to verify the attachment exists and check size.
//   2. Resolve the attachment by ID, filename, or sole-attachment fallback (#2281).
//   3. Enforce 10 MB cap — avoids excessive memory use for large files.
//   4. Download raw bytes via CeoNylasClient.downloadAttachment().
//   5. Return base64-encoded content + metadata.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { locateInMailbox, mailboxFields } from '../../../_shared/principal-mailbox-client.js';
import {
  attachmentSelectorPresent,
  resolveAttachment,
} from '../../../_shared/resolve-attachment.js';
import { nylasMessageFailure, validateNylasMessageId } from '../../../../src/channels/email/nylas-message-id.js';
import { MAX_TEMP_FILE_BYTES } from '../../../../src/skills/temp-file-store.js';

export class CeoInboxDownloadAttachmentHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    // Pass selector strings through untrimmed — resolveAttachment owns normalization.
    const attachmentId = typeof input.attachment_id === 'string' ? input.attachment_id : undefined;
    const filename = typeof input.filename === 'string' ? input.filename : undefined;
    const messageId =
      typeof input.message_id === 'string' ? input.message_id.trim() : '';

    if (!messageId) {
      return { success: false, error: 'message_id is required' };
    }
    if (!attachmentSelectorPresent({ attachmentId, filename })) {
      return {
        success: false,
        error: 'attachment_id or filename is required',
      };
    }

    const idError = validateNylasMessageId(messageId);
    if (idError) {
      return { success: false, error: idError, errorType: 'VALIDATION_ERROR' };
    }

    const located = await locateInMailbox(ctx, input, 'ceo-inbox-download-attachment', 'message', messageId);
    if (!located.ok) return { success: false, error: located.error, ...(located.errorType ? { errorType: located.errorType } : {}) };
    const { client, mailbox } = located.at;
    const mbx = mailboxFields(mailbox);

    // Fetch the full message to verify the attachment exists and get its metadata.
    let msg: Awaited<ReturnType<typeof client.getMessage>>;
    try {
      msg = await client.getMessage(messageId);
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-download-attachment: failed to fetch message');
      return { success: false, ...nylasMessageFailure(err, messageId, 'Failed to fetch message') };
    }

    const resolved = resolveAttachment({
      attachments: msg.attachments,
      attachmentId,
      filename,
      messageId,
      log: ctx.log,
      logContext: 'ceo-inbox-download-attachment',
    });
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }
    const { attachment, resolvedBy } = resolved;

    if (attachment.size > MAX_TEMP_FILE_BYTES) {
      const sizeMB = (attachment.size / (1024 * 1024)).toFixed(1);
      return {
        success: false,
        error: `Attachment "${attachment.filename}" is ${sizeMB} MB — exceeds the 10 MB download limit`,
      };
    }

    ctx.log.info(
      {
        attachmentId: attachment.id,
        messageId,
        filename: attachment.filename,
        declaredSize: attachment.size,
        resolvedBy,
      },
      'ceo-inbox-download-attachment: downloading',
    );

    let buffer: Buffer;
    try {
      buffer = await client.downloadAttachment(attachment.id, messageId);
    } catch (err) {
      ctx.log.error(
        { err, attachmentId: attachment.id, messageId },
        'ceo-inbox-download-attachment: download failed',
      );
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Failed to download attachment "${attachment.filename}": ${detail}`,
      };
    }

    // Post-download size check — catches cases where the declared size was 0 (missing) or incorrect.
    if (buffer.length > MAX_TEMP_FILE_BYTES) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
      ctx.log.warn(
        { attachmentId: attachment.id, messageId, actualBytes: buffer.length, declaredSize: attachment.size },
        'ceo-inbox-download-attachment: actual download size exceeded limit',
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
        ctx.log.warn({ err, filename: attachment.filename }, 'ceo-inbox-download-attachment: writeTempFile failed');
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
        resolved_by: resolvedBy,
        ...mbx,
        ...(tempFileUrl ? {} : { content_base64: buffer.toString('base64') }),
      },
    };
  }
}
