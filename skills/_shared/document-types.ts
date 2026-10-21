// MIME types and filename extensions that file-parse can read, shared with
// archive-extract so an extracted entry is labelled the same way it will be parsed.

export type DocumentKind = 'csv' | 'pdf' | 'image' | 'html' | 'ics' | 'text' | 'xml' | 'markdown';

/** MIME type (no parameters) → parser. `image/jpg` is the non-standard alias some mail clients send. */
export const DOCUMENT_MIME_TYPES: Record<string, DocumentKind> = {
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'text/html': 'html',
  'text/calendar': 'ics',
  'application/ics': 'ics',
  'text/x-vcalendar': 'ics',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
};

/** Lowercase extension, including the dot, → MIME type. Used only as a fallback. */
export const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.ics': 'text/calendar',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Last extension of the basename, lowercased, including the dot. Empty when there is none. */
export function filenameExtension(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').filter((part) => part.length > 0).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // A leading dot is a dotfile (".gitignore"), not an extension.
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** MIME type implied by the filename extension, or undefined when the extension is unknown. */
export function mimeTypeFromFilename(filename: string): string | undefined {
  const ext = filenameExtension(filename);
  if (!ext) return undefined;
  return EXTENSION_MIME_TYPES[ext];
}

/**
 * A specific reported MIME type wins. The extension is consulted only when the
 * reported type is missing or the generic `application/octet-stream`, so renaming
 * a file cannot switch parsers on an attachment the sender typed correctly.
 * The returned type may still be one file-parse does not support.
 */
export function effectiveDocumentMime(reportedMime: string, filename: string): string {
  const mime = reportedMime.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime && mime !== 'application/octet-stream') return mime;
  return mimeTypeFromFilename(filename) ?? mime;
}
