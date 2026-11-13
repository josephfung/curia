// Composite page token for the ceo-inbox tools that read every principal mailbox (#2475).
//
// One token carries a resume point per mailbox. A mailbox's fetched items may be cut by the
// merged `limit`, so its resume point cannot be Nylas's next cursor: it is the cursor that
// produced the page being read plus how many of that page's items were already returned.
// `null` means the mailbox is exhausted. Base64url JSON.
//
// A token is bound to the request that made it (`scope`: the query or filters) and to its page
// size: a follow-up with other filters would otherwise continue the earlier listing.

import { createHash } from 'node:crypto';

export interface MailboxPosition {
  /** The Nylas cursor that produced the page being read; null for the first page. */
  cursor: string | null;
  /** Raw items of that page already returned (or dropped by the handler's filters). */
  skip: number;
  /**
   * The last item consumed from that page. When the page is fetched again its contents may
   * have changed (triage archived or read some of it), so the scan resumes just after this
   * item, not at `skip`. Absent: resume at `skip`.
   */
  after?: { id: string; date: number };
}

export type PageCursors = Record<string, MailboxPosition | null>;

/** A short fingerprint of the request a token continues (tool, query, filters). Never the text itself. */
export function pageScope(parts: Record<string, string | boolean | number | null>): string {
  const canonical = JSON.stringify(Object.keys(parts).sort().map((k) => [k, parts[k]]));
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16);
}

/**
 * `limit` is the page size that produced the token: a skip count only means something at that
 * size. `scope` identifies the request (query and filters) the token continues.
 */
export function encodePageToken(positions: PageCursors, limit: number, scope: string): string {
  return Buffer.from(JSON.stringify({ limit, scope, mailboxes: positions }), 'utf8').toString('base64url');
}

/** Throws on anything that is not a token this module produced. */
export function decodePageToken(token: string): { limit: number; scope: string | undefined; positions: PageCursors } {
  const outer: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  const { limit, scope, mailboxes: parsed } = (outer ?? {}) as { limit?: unknown; scope?: unknown; mailboxes?: unknown };
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) throw new Error('page token has no page size');
  if (scope !== undefined && typeof scope !== 'string') throw new Error('page token scope is malformed');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('page token is not an object');
  }
  // No prototype (S2): a mailbox id may be `constructor` or `toString` (they match the id pattern),
  // so lookups must see only the token's own entries. Readers use Object.hasOwn too.
  const out: PageCursors = Object.create(null) as PageCursors;
  for (const [id, value] of Object.entries(parsed)) {
    if (value === null) {
      out[id] = null;
      continue;
    }
    const pos = value as { cursor?: unknown; skip?: unknown; after?: unknown } | undefined;
    const ok =
      typeof pos === 'object' && pos !== null &&
      (pos.cursor === null || typeof pos.cursor === 'string') &&
      typeof pos.skip === 'number' && Number.isInteger(pos.skip) && pos.skip >= 0;
    if (!ok) throw new Error(`page token position for ${id} is malformed`);
    const after = readAfter(pos.after);
    if (after === false) throw new Error(`page token position for ${id} is malformed`);
    out[id] = { cursor: pos.cursor as string | null, skip: pos.skip as number, ...(after ? { after } : {}) };
  }
  return { limit, scope, positions: out };
}

/** The `after` anchor, undefined when absent, false when malformed. */
function readAfter(raw: unknown): { id: string; date: number } | undefined | false {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object') return false;
  const { id, date } = raw as { id?: unknown; date?: unknown };
  if (typeof id !== 'string' || typeof date !== 'number' || !Number.isFinite(date)) return false;
  return { id, date };
}
