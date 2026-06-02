// parse-attachments.ts — validates and normalises the raw `attachments` input
// from an LLM skill call into the OutboundAttachmentInput shape expected by
// the outbound gateway and CEO inbox handlers.
//
// Returns an error string on validation failure (caller returns { success: false, error }).
// Returns an empty array when attachments is undefined/null (not an error).

import type { OutboundAttachmentInput } from '../../src/skills/_shared/read-attachments.js';

/**
 * Parse and validate the raw `attachments` value from a skill input.
 *
 * @param raw  The raw value from ctx.input — may be undefined, null, or an unknown array.
 * @returns    A validated OutboundAttachmentInput[] on success, or an error string on failure.
 */
export function parseAttachmentInputs(raw: unknown): OutboundAttachmentInput[] | string {
  if (raw === undefined || raw === null) return [];

  if (!Array.isArray(raw)) {
    return 'attachments must be an array of {file_url, filename, content_type} objects';
  }

  const result: OutboundAttachmentInput[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null) {
      return `attachments[${i}] must be an object with file_url, filename, and content_type`;
    }

    const obj = entry as Record<string, unknown>;
    const fileUrl = obj['file_url'];
    const filename = obj['filename'];
    const contentType = obj['content_type'];

    if (typeof fileUrl !== 'string' || !fileUrl) {
      return `attachments[${i}].file_url must be a non-empty string (got ${JSON.stringify(fileUrl)})`;
    }
    if (typeof filename !== 'string' || !filename) {
      return `attachments[${i}].filename must be a non-empty string (got ${JSON.stringify(filename)})`;
    }
    if (typeof contentType !== 'string' || !contentType) {
      return `attachments[${i}].content_type must be a non-empty string (got ${JSON.stringify(contentType)})`;
    }

    result.push({ fileUrl, filename, contentType });
  }

  return result;
}
