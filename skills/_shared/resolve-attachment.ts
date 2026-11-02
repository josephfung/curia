/**
 * Resolve which attachment on a message the model meant to download.
 *
 * Gmail-via-Nylas attachment IDs are long opaque strings (90–180 chars). Models
 * regularly mistype them even when the correct value is in context (#2281) —
 * the same failure class as ADR-047 for recipient addresses. Filename is short
 * and readable; a sole attachment on a verified message is unambiguous. Prefer
 * those over fuzzy matching the opaque ID.
 */

import type { Logger } from '../../src/logger.js';
import { createSecretPatterns } from '../../src/security/secret-patterns.js';

/** Minimal attachment shape both Nylas clients expose to download handlers. */
export interface ResolvableAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export type AttachmentResolvedBy = 'id' | 'filename' | 'sole_attachment';

export interface ResolveAttachmentSuccess {
  ok: true;
  attachment: ResolvableAttachment;
  resolvedBy: AttachmentResolvedBy;
}

export interface ResolveAttachmentFailure {
  ok: false;
  error: string;
}

export type ResolveAttachmentResult = ResolveAttachmentSuccess | ResolveAttachmentFailure;

export interface ResolveAttachmentOptions {
  attachments: readonly ResolvableAttachment[];
  /** Model-supplied attachment ID (may be empty, truncated, or garbled). */
  attachmentId?: string;
  /** Optional case-sensitive filename; preferred when the ID is unreliable. */
  filename?: string;
  messageId: string;
  log: Logger;
  /** Prefix for structured warn/info logs (skill name). */
  logContext: string;
}

/**
 * True when the caller supplied a usable attachment_id and/or filename after trim.
 * Handlers use this before fetching the message; the helper owns trim for matching.
 */
export function attachmentSelectorPresent(options: {
  attachmentId?: string;
  filename?: string;
}): boolean {
  return Boolean(
    (typeof options.attachmentId === 'string' && options.attachmentId.trim()) ||
      (typeof options.filename === 'string' && options.filename.trim()),
  );
}

/**
 * Format the attachments that exist on a message for an error string the model
 * can use on the next attempt (filename is the recommended retry key).
 */
export function formatAttachmentListing(attachments: readonly ResolvableAttachment[]): string {
  if (attachments.length === 0) {
    return 'Message has no attachments.';
  }
  const lines = attachments.map(
    (a) =>
      `- filename=${JSON.stringify(a.filename)} content_type=${JSON.stringify(a.contentType)} ` +
      `size=${a.size} id=${a.id}`,
  );
  return `Attachments on this message:\n${lines.join('\n')}`;
}

const REDACTION_MARKER = '[REDACTED]';

/**
 * Apply the same secret redaction sanitizeOutput applies to skill output, so a
 * filename can be compared with the redacted form the model was shown (#2430).
 * Mimecast DMARC reports end in a 32+ hex report ID that the long-hex rule scrubs.
 */
function redactLikeSkillOutput(filename: string): string {
  let text = filename;
  for (const pattern of createSecretPatterns()) {
    text = text.replace(pattern, REDACTION_MARKER);
  }
  return text;
}

interface FilenameMatch {
  matches: ResolvableAttachment[];
  /** True when only the redaction-aware pass matched. */
  viaRedaction: boolean;
}

/**
 * Match filename in three passes: exact (preserves whitespace the model copied from
 * a listing), then trimmed equality, then — only when the requested name carries a
 * redaction marker — equality against each attachment's redacted name. Earlier
 * passes win so `"a.pdf"` does not collide with `"a.pdf "` when both exist, and a
 * real name never loses to a redacted look-alike.
 */
function matchAttachmentsByFilename(
  attachments: readonly ResolvableAttachment[],
  filenameRaw: string,
  filenameKey: string,
): FilenameMatch {
  const exact = attachments.filter((a) => a.filename === filenameRaw);
  if (exact.length > 0) return { matches: exact, viaRedaction: false };
  const trimmed = attachments.filter((a) => a.filename.trim() === filenameKey);
  if (trimmed.length > 0 || !filenameKey.includes(REDACTION_MARKER)) {
    return { matches: trimmed, viaRedaction: false };
  }
  const redacted = attachments.filter((a) => {
    const shown = redactLikeSkillOutput(a.filename);
    return shown === filenameRaw || shown.trim() === filenameKey;
  });
  return { matches: redacted, viaRedaction: redacted.length > 0 };
}

function filenameConflictsWithResolved(
  attachment: ResolvableAttachment,
  filenameRaw: string,
  filenameKey: string,
): boolean {
  return matchAttachmentsByFilename([attachment], filenameRaw, filenameKey).matches.length === 0;
}

/**
 * Resolve an attachment by exact ID, then unique filename, then sole-attachment
 * fallback (only when no filename was supplied). Returns a structured error
 * listing available attachments when none of those succeed.
 */
export function resolveAttachment(options: ResolveAttachmentOptions): ResolveAttachmentResult {
  // Helper owns normalization — handlers pass raw input strings through.
  const attachmentId = options.attachmentId?.trim() ?? '';
  const filenameRaw = typeof options.filename === 'string' ? options.filename : '';
  const filenameKey = filenameRaw.trim();
  const { attachments, messageId, log, logContext } = options;

  if (attachments.length === 0) {
    return {
      ok: false,
      error: `Message ${messageId} has no attachments — check message_id.`,
    };
  }

  if (attachmentId) {
    const byId = attachments.find((a) => a.id === attachmentId);
    if (byId) {
      if (filenameKey && filenameConflictsWithResolved(byId, filenameRaw, filenameKey)) {
        log.warn(
          {
            messageId,
            requestedAttachmentId: attachmentId,
            requestedFilename: filenameRaw,
            resolvedAttachmentId: byId.id,
            resolvedFilename: byId.filename,
            resolvedBy: 'id',
          },
          `${logContext}: attachment_id and filename disagree; using attachment_id`,
        );
      }
      return { ok: true, attachment: byId, resolvedBy: 'id' };
    }
  }

  if (filenameKey) {
    const { matches: byName, viaRedaction } = matchAttachmentsByFilename(
      attachments,
      filenameRaw,
      filenameKey,
    );
    if (byName.length === 1) {
      const attachment = byName[0]!;
      const payload = {
        messageId,
        requestedAttachmentId: attachmentId || undefined,
        resolvedAttachmentId: attachment.id,
        filename: attachment.filename,
        resolvedBy: 'filename' as const,
        ...(viaRedaction ? { matchedRedactedFilename: true } : {}),
      };
      if (attachmentId) {
        // Mistranscription recovery — the signal the issue asked for.
        log.warn(payload, `${logContext}: resolved attachment by filename after ID miss`);
      } else {
        // Recommended happy path once the model passes filename alone.
        log.info(payload, `${logContext}: resolved attachment by filename`);
      }
      return { ok: true, attachment, resolvedBy: 'filename' };
    }
    if (byName.length > 1) {
      return {
        ok: false,
        error:
          `Filename ${JSON.stringify(filenameRaw)} matches ${byName.length} attachments on ` +
          `message ${messageId} — copy the id exactly as listed below to disambiguate. ` +
          formatAttachmentListing(attachments),
      };
    }
    // Explicit filename that matched nothing: do not sole-fallback. A readable
    // wrong name is positive evidence the agent expects a different file
    // (e.g. sibling message in a reply chain).
  }

  // Sole-attachment only when the model did not assert a filename. A garbled or
  // made-up ID on a one-attachment message is the #2281 recovery path.
  if (!filenameKey && attachments.length === 1) {
    const attachment = attachments[0]!;
    log.warn(
      {
        messageId,
        requestedAttachmentId: attachmentId || undefined,
        resolvedAttachmentId: attachment.id,
        resolvedBy: 'sole_attachment',
      },
      `${logContext}: resolved sole attachment after ID miss`,
    );
    return { ok: true, attachment, resolvedBy: 'sole_attachment' };
  }

  const requestedParts: string[] = [];
  if (attachmentId) requestedParts.push(`id ${attachmentId}`);
  if (filenameKey) requestedParts.push(`filename ${JSON.stringify(filenameRaw)}`);
  const requested =
    requestedParts.length > 0
      ? `Attachment (${requestedParts.join(', ')})`
      : 'Attachment';

  // Selector miss with no recovery — keep mistranscription rates visible now that
  // filename is the recommended key and sole-attachment no longer covers a wrong name.
  if (attachmentId || filenameKey) {
    log.warn(
      {
        messageId,
        requestedAttachmentId: attachmentId || undefined,
        requestedFilename: filenameKey ? filenameRaw : undefined,
        attachmentCount: attachments.length,
        resolvedBy: 'none',
      },
      `${logContext}: attachment selector miss`,
    );
  }

  // After a filename miss, steer the retry to the ID: the listed name can differ
  // from the real one (e.g. secret redaction, #2430), so another filename guess
  // is likely to miss again. An ID-only miss keeps filename as the preferred key.
  const retryHint = filenameKey
    ? `The filename did not match — retry with attachment_id copied exactly from the list below, not another filename. `
    : `Pass filename (preferred) or copy the exact attachment_id from the list below. `;

  return {
    ok: false,
    error: `${requested} not found on message ${messageId}. ` + retryHint + formatAttachmentListing(attachments),
  };
}
