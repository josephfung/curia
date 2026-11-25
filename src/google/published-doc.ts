// published-doc.ts — the record of the Google Doc a stored document is published to (#2758).
//
// The OKF document stays the source of truth; the Doc is a formatted copy made by
// doc-publish-google. The record lives in the document's frontmatter under `google_doc`, so a
// doc-read shows where the Doc is and a later publish updates the same Doc instead of creating
// another.

/** Frontmatter key holding the record. */
export const GOOGLE_DOC_KEY = 'google_doc';

export interface PublishedDocRecord {
  id: string;
  url: string;
  /** When the Doc was last written from the store (ISO 8601, UTC). */
  published_at: string;
  /**
   * The Doc's Drive `modifiedTime` right after that write. A later Drive `modifiedTime` means
   * someone changed the Doc since, so republishing would overwrite their edits.
   */
  modified_time: string;
}

/**
 * The record in `frontmatter`, or null when there is none. A value that is not a well-formed
 * record (an agent hand-edited it, or a replace dropped fields) is reported as `invalid` rather
 * than treated as absent: publishing then would silently start a second Doc.
 */
export function readPublishedDocRecord(
  frontmatter: Record<string, unknown> | undefined,
): { record: PublishedDocRecord } | { record: null } | { invalid: true } {
  const raw = frontmatter?.[GOOGLE_DOC_KEY];
  if (raw === undefined || raw === null) return { record: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { invalid: true };
  const value = raw as Record<string, unknown>;
  const fields = ['id', 'url', 'published_at', 'modified_time'] as const;
  if (!fields.every((field) => typeof value[field] === 'string' && (value[field] as string).length > 0)) {
    return { invalid: true };
  }
  return {
    record: {
      id: value.id as string,
      url: value.url as string,
      published_at: value.published_at as string,
      modified_time: value.modified_time as string,
    },
  };
}
