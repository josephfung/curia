// Composite page token for the ceo-inbox tools that read every principal mailbox (#2475).
//
// One token carries a resume point per mailbox. A mailbox's fetched items may be cut by the
// merged `limit`, so its resume point cannot be Nylas's next cursor: it is the cursor that
// produced the page being read plus how many of that page's items were already returned.
// `null` means the mailbox is exhausted. Base64url JSON.

export interface MailboxPosition {
  /** The Nylas cursor that produced the page being read; null for the first page. */
  cursor: string | null;
  /** Raw items of that page already returned (or dropped by the handler's filters). */
  skip: number;
}

export type PageCursors = Record<string, MailboxPosition | null>;

/** `limit` is the page size that produced the token: a skip count only means something at that size. */
export function encodePageToken(positions: PageCursors, limit: number): string {
  return Buffer.from(JSON.stringify({ limit, mailboxes: positions }), 'utf8').toString('base64url');
}

/** Throws on anything that is not a token this module produced. */
export function decodePageToken(token: string): { limit: number; positions: PageCursors } {
  const outer: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  const { limit, mailboxes: parsed } = (outer ?? {}) as { limit?: unknown; mailboxes?: unknown };
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) throw new Error('page token has no page size');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('page token is not an object');
  }
  const out: PageCursors = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (value === null) {
      out[id] = null;
      continue;
    }
    const pos = value as { cursor?: unknown; skip?: unknown } | undefined;
    const ok =
      typeof pos === 'object' && pos !== null &&
      (pos.cursor === null || typeof pos.cursor === 'string') &&
      typeof pos.skip === 'number' && Number.isInteger(pos.skip) && pos.skip >= 0;
    if (!ok) throw new Error(`page token position for ${id} is malformed`);
    out[id] = { cursor: pos.cursor as string | null, skip: pos.skip as number };
  }
  return { limit, positions: out };
}
