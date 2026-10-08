// tests/scenarios/attachment-guard.ts — production's email attachment boundary (#2059).
//
// `email-send` and `email-reply` stubs answer the send. They cannot see what
// readAttachmentFiles (src/skills/_shared/read-attachments.ts) refuses before the
// gateway ever sends: a file_url outside the temp store. A scenario file does not
// have to exist on disk — a drive-download-file stub stands in for one inside the
// store — so this checks the path boundary only, not that the file is readable.
//
// The message is the one the skill returns: the gateway's `Attachment error:`
// prefix around readAttachmentFiles' own text.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const EMAIL_ATTACHMENT_TOOLS: ReadonlySet<string> = new Set(['email-send', 'email-reply']);

/** Same default as TempFileStore and readAttachmentFiles. */
export function scenarioTempStoreDir(storeDir?: string): string {
  return path.resolve(storeDir ?? process.env['CURIA_TEMPFILE_DIR'] ?? '/run/curia-tempfiles');
}

/**
 * The error production would return for this call's attachments, or undefined when
 * the call is not an email send/reply or every file_url stays inside the temp store.
 * `storeDir` overrides the directory (tests); otherwise CURIA_TEMPFILE_DIR, then
 * /run/curia-tempfiles.
 */
export function emailAttachmentRefusal(
  toolName: string,
  input: Record<string, unknown>,
  storeDir?: string,
): string | undefined {
  if (!EMAIL_ATTACHMENT_TOOLS.has(toolName)) return undefined;
  const raw = input['attachments'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const store = scenarioTempStoreDir(storeDir);
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const fileUrl = (entry as Record<string, unknown>)['file_url'];
    if (typeof fileUrl !== 'string' || fileUrl === '') continue;
    const message = attachmentBoundaryMessage(fileUrl, store);
    if (message) return `Attachment error: ${message}`;
  }
  return undefined;
}

/**
 * readAttachmentFiles' checks that do not need the file to exist. A file:// URL
 * whose resolved path leaves the store gets the boundary error; anything else
 * gets the file:// requirement. Both are what production throws.
 */
function attachmentBoundaryMessage(fileUrl: string, storeDir: string): string | undefined {
  if (!fileUrl.startsWith('file://')) {
    return `Invalid attachment file_url "${fileUrl}": must start with file://`;
  }
  let resolved: string;
  try {
    resolved = path.resolve(fileURLToPath(fileUrl));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Invalid attachment file_url "${fileUrl}": ${detail}`;
  }
  // Same boundary as readAttachmentFiles: path.relative starts with '..' or is
  // absolute when the target is outside the store. A name like `..hidden` inside
  // the store is rejected there too, so the scenario agrees with production.
  const relative = path.relative(storeDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return `Attachment path is outside the allowed temp store directory: ${fileUrl}`;
  }
  return undefined;
}
