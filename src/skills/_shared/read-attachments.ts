// Shared helper for resolving outbound email attachments from temp file URLs.
//
// Skills receive attachments as { file_url, filename, content_type } from the
// LLM — file_url is a file:// URL written by TempFileStore. This helper
// validates the URLs, reads the Buffers from disk, and enforces size limits
// before the content is handed to a transport (NylasClient or CeoNylasClient).

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/** Per-attachment metadata as supplied by the LLM via a skill input. */
export interface OutboundAttachmentInput {
  /** file:// URL returned by email-download-attachment or a similar tool. */
  fileUrl: string;
  /** Display filename (e.g. "report.pdf"). */
  filename: string;
  /** MIME type (e.g. "application/pdf"). */
  contentType: string;
}

/** Resolved attachment ready for transport — URL replaced with raw bytes. */
export interface AttachmentContent {
  filename: string;
  contentType: string;
  content: Buffer;
}

const MAX_ATTACHMENTS = 10;

/**
 * Validate and read attachment files from disk.
 *
 * Validates each file_url (must be a file:// URL within the temp store directory),
 * reads each file, and enforces a total size cap.
 *
 * @param attachments  Raw attachment list from skill input.
 * @param maxTotalBytes  Maximum combined size of all attachments in bytes.
 * @param storeDir  Allowed directory — resolved paths must be within this prefix.
 *   Defaults to CURIA_TEMPFILE_DIR env var or /run/curia-tempfiles (matches TempFileStore).
 *   Read at call time so tests can override via process.env or explicit argument.
 * @returns Resolved attachment contents ready to pass to a transport.
 * @throws Error with a user-visible message on any validation or I/O failure.
 */
export async function readAttachmentFiles(
  attachments: OutboundAttachmentInput[],
  maxTotalBytes: number,
  storeDir?: string,
): Promise<AttachmentContent[]> {
  if (attachments.length === 0) return [];
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments: ${attachments.length} provided, maximum is ${MAX_ATTACHMENTS}`);
  }

  // Resolve the store dir at call time so tests can set CURIA_TEMPFILE_DIR before calling.
  // Matches TempFileStore constructor: CURIA_TEMPFILE_DIR env var → /run/curia-tempfiles fallback.
  const resolvedStoreDir = path.resolve(
    storeDir ?? process.env['CURIA_TEMPFILE_DIR'] ?? '/run/curia-tempfiles',
  );

  const results: AttachmentContent[] = [];
  let totalBytes = 0;

  for (const att of attachments) {
    if (!att.fileUrl.startsWith('file://')) {
      throw new Error(`Invalid attachment file_url "${att.fileUrl}": must start with file://`);
    }
    // Defense-in-depth: reject literal .. before URL-parsing so URL-encoded
    // variants don't bypass this check. The storeDir boundary below catches
    // anything that makes it through URL decoding.
    if (att.fileUrl.includes('..')) {
      throw new Error(`Invalid attachment file_url "${att.fileUrl}": path traversal not allowed`);
    }
    if (!att.filename || typeof att.filename !== 'string') {
      throw new Error('Each attachment must have a non-empty filename');
    }
    if (!att.contentType || typeof att.contentType !== 'string') {
      throw new Error(`Attachment "${att.filename}" must have a non-empty content_type`);
    }

    // Use URL parsing so percent-encoded characters are decoded before path resolution.
    const filePath = new URL(att.fileUrl).pathname;

    // Enforce that the resolved path stays within the temp store directory — prevents
    // LLM-driven prompt injection from exfiltrating arbitrary files (e.g. /etc/passwd,
    // .env) as email attachments. Matches the same boundary check in TempFileStore.delete().
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(resolvedStoreDir + path.sep)) {
      throw new Error(
        `Attachment path is outside the allowed temp store directory: ${att.fileUrl}`,
      );
    }

    let content: Buffer;
    try {
      content = await readFile(resolvedPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read attachment "${att.filename}" from ${att.fileUrl}: ${detail}`);
    }

    totalBytes += content.length;
    if (totalBytes > maxTotalBytes) {
      const limitMB = (maxTotalBytes / (1024 * 1024)).toFixed(0);
      throw new Error(
        `Attachments exceed the ${limitMB} MB total size limit. ` +
        `Reduce attachment size or count before sending.`,
      );
    }

    results.push({ filename: att.filename, contentType: att.contentType, content });
  }

  return results;
}
