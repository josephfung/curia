// Reading every principal mailbox for ceo-inbox-list and ceo-inbox-search (#2475).
//
// Each mailbox is scanned from its own resume point, the scans are merged newest first, and the
// merged list is cut to `limit`. Because the cut can leave some mailbox's fetched items unreturned,
// each mailbox resumes from the position just after its last returned item (see composite-page-token.ts),
// so paging never skips or repeats a message.

import type { ToolContext } from '../../src/skills/types.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import { nylasStatus } from '../../src/channels/email/nylas-message-id.js';
import type { CeoNylasClient } from './ceo-nylas-client.js';
import { decodePageToken, type MailboxPosition, type PageCursors } from './composite-page-token.js';
import { mailboxFields, namedOrDefaultMailbox, readMailboxInput, settledMailboxClients } from './principal-mailbox-client.js';

export interface Target {
  mailbox: PrincipalMailboxView;
  client?: CeoNylasClient;
  /** Why there is no client (an error class name). */
  failure?: string;
}

export interface MailboxError {
  mailbox: string;
  mailbox_label: string;
  error: string;
  note: string;
}

const NOT_INCLUDED = 'Its mail is not included; a later call retries it.';

const FRESH: MailboxPosition = { cursor: null, skip: 0 };

/** The error class or HTTP status only. Never a message, which could carry a grant id. */
export function describeError(err: unknown): string {
  const status = nylasStatus(err);
  if (status !== undefined) return `HTTP ${status}`;
  return err instanceof Error ? err.constructor.name : 'Error';
}

/** The mailboxes to read: the named one, or every live one. Unknown or removed ids are errors. */
export async function resolveTargets(
  ctx: ToolContext,
  input: unknown,
  tool: string,
): Promise<{ ok: true; targets: Target[] } | { ok: false; error: string }> {
  const parsed = readMailboxInput(input);
  if (!parsed.ok) return parsed;
  if (parsed.mailbox !== undefined) {
    const picked = await namedOrDefaultMailbox(ctx, input, tool);
    if (!picked.ok) return { ok: false, error: picked.error };
    return { ok: true, targets: [{ mailbox: picked.at.mailbox, client: picked.at.client }] };
  }
  try {
    const settled = await settledMailboxClients(ctx);
    if (settled.length === 0) return { ok: false, error: 'No principal mailbox is connected.' };
    return {
      ok: true,
      targets: settled.map((s) => ({
        mailbox: s.mailbox,
        ...(s.at ? { client: s.at.client } : {}),
        ...(s.failure ? { failure: s.failure } : {}),
      })),
    };
  } catch (err) {
    ctx.log.error({ err, tool }, `${tool}: could not list the principal mailboxes`);
    return { ok: false, error: 'The principal mailboxes are unavailable.' };
  }
}

/**
 * The optional `page_token` input, decoded. An undecodable token, one made at another page size
 * (its skip counts would point at the wrong items), one made for another query or other filters
 * (`scope`: it would continue the earlier listing), or one that lacks the explicitly named
 * mailbox is an error that says how to recover.
 */
export function readPageToken(input: unknown, limit: number, scope: string): { ok: true; cursors: PageCursors | undefined } | { ok: false; error: string } {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const raw = rec['page_token'];
  if (raw === undefined || raw === null || raw === '') return { ok: true, cursors: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'page_token must be a string. Retry without page_token.' };
  let decoded: ReturnType<typeof decodePageToken>;
  try {
    decoded = decodePageToken(raw);
  } catch {
    return { ok: false, error: 'That page_token is not valid (it may predate an upgrade). Retry without page_token.' };
  }
  if (decoded.limit !== limit) {
    return { ok: false, error: 'Retry without page_token (the page size changed).' };
  }
  if (decoded.scope !== scope) {
    return { ok: false, error: 'That page_token belongs to another query or other filters. Retry without page_token.' };
  }
  const named = rec['mailbox'];
  if (typeof named === 'string' && !(named in decoded.positions)) {
    return { ok: false, error: 'That page_token does not cover this mailbox. Retry without page_token.' };
  }
  return { ok: true, cursors: decoded.positions };
}

// ── One mailbox ──────────────────────────────────────────────────────────────

export interface ScanItem<T> {
  item: T;
  /** Where to resume to continue just after this item; null when it was the mailbox's last. */
  after: MailboxPosition | null;
}

export interface ScanResult<T> {
  items: Array<ScanItem<T>>;
  /** Position after everything scanned; null when the mailbox is exhausted. */
  end: MailboxPosition | null;
  /** The page cap stopped the scan before the mailbox was exhausted. */
  capped: boolean;
}

type Anchored = { id: string; date: number };

function positionAfter(cursor: string | null, raw: Anchored[], consumed: number, next: string | undefined): MailboxPosition | null {
  if (consumed < raw.length) {
    const last = raw[consumed - 1]!;
    return { cursor, skip: consumed, after: { id: last.id, date: last.date } };
  }
  return next && raw.length > 0 ? { cursor: next, skip: 0 } : null;
}

/**
 * Where to start in a re-fetched page. Its contents may have changed since the token was made
 * (triage archives or reads mail, so it leaves an unread listing), which makes a raw offset skip
 * messages. Resume just after the anchor item when it is still there; when it is gone, at the
 * first item not newer than it (pages are newest first). An item with the anchor's exact date
 * may then come back a second time, but none is skipped.
 */
function resumeIndex(raw: Anchored[], start: MailboxPosition): number {
  if (!start.after) return start.skip;
  const { id, date } = start.after;
  const at = raw.findIndex((m) => m.id === id);
  if (at >= 0) return at + 1;
  const older = raw.findIndex((m) => m.date <= date);
  return older < 0 ? raw.length : older;
}

/**
 * Scan one mailbox from `start` until `need` kept items are collected, the mailbox ends, or the
 * page cap is hit. `keep` filters a raw item; skipped items still advance the position.
 */
export async function scanMailbox<T extends Anchored>(opts: {
  start: MailboxPosition;
  need: number;
  pageCap: number;
  fetchPage: (cursor: string | undefined) => Promise<{ messages: T[]; nextCursor?: string }>;
  keep: (item: T) => boolean;
}): Promise<ScanResult<T>> {
  const items: Array<ScanItem<T>> = [];
  let cursor = opts.start.cursor;
  let skip: number | undefined;
  let end: MailboxPosition | null = opts.start;
  let capped = false;
  for (let page = 0; page < opts.pageCap; page++) {
    const { messages: raw, nextCursor } = await opts.fetchPage(cursor ?? undefined);
    // Only the first page is a resumed one; later pages start at their beginning.
    const from = skip ?? resumeIndex(raw, opts.start);
    for (let i = from; i < raw.length; i++) {
      const item = raw[i]!;
      if (opts.keep(item)) items.push({ item, after: positionAfter(cursor, raw, i + 1, nextCursor) });
    }
    skip = 0;
    end = positionAfter(cursor, raw, raw.length, nextCursor);
    if (items.length >= opts.need || end === null) break;
    if (page === opts.pageCap - 1) {
      capped = true;
      break;
    }
    cursor = end.cursor;
  }
  return { items, end, capped };
}

// ── Every mailbox ────────────────────────────────────────────────────────────

export type Labelled<T> = T & { mailbox: string; mailbox_label: string };

export interface CrossResult<T> {
  /** Merged, newest first, cut to `limit`, each labelled with its mailbox. */
  items: Array<Labelled<T>>;
  /** Fetched items were left out of `items`, or a capped scan still held items. */
  hasMore: boolean;
  /** Some mailbox may still have items: build a page token from `positions`. */
  anyOpen: boolean;
  capped: boolean;
  errors: MailboxError[];
  allFailed: boolean;
  /** Resume point per mailbox (null: exhausted); a failed mailbox keeps the point it started from. */
  positions: PageCursors;
}

export async function listAcrossMailboxes<T extends { id: string; date: number }>(
  targets: Target[],
  cursors: PageCursors | undefined,
  opts: {
    limit: number;
    need: number;
    pageCap: number;
    fetchPage: (client: CeoNylasClient, cursor: string | undefined) => Promise<{ messages: T[]; nextCursor?: string }>;
    keep: (item: T) => boolean;
  },
): Promise<CrossResult<T>> {
  type Outcome =
    | { target: Target; start: MailboxPosition | null; result: ScanResult<T> }
    | { target: Target; start: MailboxPosition | null; error: string };

  const outcomes: Outcome[] = await Promise.all(
    targets.map(async (target): Promise<Outcome> => {
      const known = cursors?.[target.mailbox.id];
      // Absent from the token (a mailbox added since): read it from the start.
      const start = known === undefined ? FRESH : known;
      if (start === null) return { target, start, result: { items: [], end: null, capped: false } };
      if (!target.client) return { target, start, error: target.failure ?? 'unavailable' };
      const client = target.client;
      try {
        const result = await scanMailbox<T>({
          start, need: opts.need, pageCap: opts.pageCap, keep: opts.keep,
          fetchPage: (cursor) => opts.fetchPage(client, cursor),
        });
        return { target, start, result };
      } catch (err) {
        return { target, start, error: describeError(err) };
      }
    }),
  );

  const errors: MailboxError[] = [];
  const positions: PageCursors = {};
  const ok: Array<{ target: Target; start: MailboxPosition | null; result: ScanResult<T> }> = [];
  for (const o of outcomes) {
    if ('error' in o) {
      errors.push({ mailbox: o.target.mailbox.id, mailbox_label: o.target.mailbox.label, error: o.error, note: NOT_INCLUDED });
      positions[o.target.mailbox.id] = o.start; // retried on the next page, not skipped
    } else {
      ok.push(o);
    }
  }

  // K-way merge: each mailbox's own order is preserved, so the returned items are a prefix of each
  // mailbox's scan and a resume point just after the last of them loses nothing.
  const taken = ok.map(() => 0);
  const items: Array<Labelled<T>> = [];
  while (items.length < opts.limit) {
    let best = -1;
    for (let i = 0; i < ok.length; i++) {
      const head = ok[i]!.result.items[taken[i]!]?.item;
      if (!head) continue;
      if (best < 0) { best = i; continue; }
      const cur = ok[best]!.result.items[taken[best]!]!.item;
      const byDate = head.date - cur.date;
      const byBox = ok[i]!.target.mailbox.id.localeCompare(ok[best]!.target.mailbox.id);
      if (byDate > 0 || (byDate === 0 && (byBox < 0 || (byBox === 0 && head.id.localeCompare(cur.id) < 0)))) best = i;
    }
    if (best < 0) break;
    const { item } = ok[best]!.result.items[taken[best]!]!;
    items.push({ ...item, ...mailboxFields(ok[best]!.target.mailbox) });
    taken[best]!++;
  }

  let leftover = false;
  let capped = false;
  let cappedWithItems = false;
  ok.forEach((o, i) => {
    const scanned = o.result.items;
    if (taken[i]! < scanned.length) {
      leftover = true;
      positions[o.target.mailbox.id] = taken[i]! > 0 ? scanned[taken[i]! - 1]!.after : o.start;
    } else {
      positions[o.target.mailbox.id] = o.result.end;
    }
    if (o.result.capped) {
      capped = true;
      if (scanned.length > 0) cappedWithItems = true;
    }
  });

  // A failed mailbox keeps its start point, so it counts as open: the token retries it (its
  // note says a later call does) even when every readable mailbox is finished.
  const anyOpen = Object.values(positions).some((p) => p !== null);
  return {
    items,
    hasMore: leftover || cappedWithItems,
    anyOpen,
    capped,
    errors,
    allFailed: ok.length === 0 && errors.length > 0,
    positions,
  };
}

/** Run `fn` against every target in parallel; a failing mailbox is reported, never fatal on its own. */
export async function collectAcross<R>(
  targets: Target[],
  fn: (client: CeoNylasClient, mailbox: PrincipalMailboxView) => Promise<R>,
): Promise<{ ok: Array<{ mailbox: PrincipalMailboxView; value: R }>; errors: MailboxError[] }> {
  const ok: Array<{ mailbox: PrincipalMailboxView; value: R }> = [];
  const errors: MailboxError[] = [];
  await Promise.all(
    targets.map(async (t) => {
      try {
        if (!t.client) throw new Error(t.failure ?? 'unavailable');
        ok.push({ mailbox: t.mailbox, value: await fn(t.client, t.mailbox) });
      } catch (err) {
        errors.push({
          mailbox: t.mailbox.id,
          mailbox_label: t.mailbox.label,
          error: t.client ? describeError(err) : (t.failure ?? 'unavailable'),
          note: NOT_INCLUDED,
        });
      }
    }),
  );
  // Promise.all settles in completion order; report in mailbox order.
  const order = new Map(targets.map((t, i) => [t.mailbox.id, i]));
  ok.sort((a, b) => order.get(a.mailbox.id)! - order.get(b.mailbox.id)!);
  errors.sort((a, b) => order.get(a.mailbox)! - order.get(b.mailbox)!);
  return { ok, errors };
}

/** Newest first, ties by mailbox id then item id; cut to `limit`; each item labelled. */
export function mergeNewestFirst<T extends { id: string; date: number }>(
  lists: Array<{ mailbox: PrincipalMailboxView; items: T[] }>,
  limit: number,
): Array<Labelled<T>> {
  const all = lists.flatMap((l) => l.items.map((item) => ({ mailbox: l.mailbox, item })));
  // One mailbox keeps Nylas's own order, so a single-mailbox install lists as it always did.
  if (lists.length > 1) all.sort((a, b) =>
    b.item.date - a.item.date ||
    a.mailbox.id.localeCompare(b.mailbox.id) ||
    a.item.id.localeCompare(b.item.id));
  return all.slice(0, limit).map(({ mailbox, item }) => ({ ...item, ...mailboxFields(mailbox) }));
}

/** The failure text for a tool whose every mailbox failed. One mailbox keeps the plain message. */
export function allFailedMessage(base: string, errors: MailboxError[]): string {
  if (errors.length < 2) return base;
  return `${base} (${errors.map((e) => `${e.mailbox_label}: ${e.error}`).join('; ')})`;
}
