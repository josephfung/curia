// Test fixture for the ceo-inbox handlers (#2475): a principalMailboxes stub with a list of
// live mailboxes, the first of them the default. Imported by handler tests only.

import type { ToolContext } from '../../src/skills/types.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import { RemovedMailboxError, UnknownMailboxError } from '../../src/principal-mailboxes/types.js';

export function mailboxView(id: string, label: string, address: string, isDefault = false): PrincipalMailboxView {
  return { id, label, address, isDefault, triageStartAt: null };
}

export interface StubOptions {
  /** Live mailboxes. Default: one default mailbox `work` at ceo@example.com. */
  mailboxes?: PrincipalMailboxView[];
  /** Grant per mailbox id; default `<apiGrant>` for all (or `grant-<id>` when given a function). */
  grantId?: string | ((id: string) => string);
  apiKey?: string;
  removed?: string[];
  /** Extra principal addresses (verified identities) beyond the mailboxes' own. */
  identityAddresses?: string[];
}

export function stubPrincipalMailboxes(opts: StubOptions = {}): NonNullable<ToolContext['principalMailboxes']> {
  const mailboxes = opts.mailboxes ?? [mailboxView('work', 'Work', 'ceo@example.com', true)];
  const grantFor = (id: string): string =>
    typeof opts.grantId === 'function' ? opts.grantId(id) : (opts.grantId ?? 'test-grant-id');
  const stub = {
    list: async () => mailboxes,
    get: async (id: string) => {
      if (opts.removed?.includes(id)) throw new RemovedMailboxError(id, id);
      const m = mailboxes.find((x) => x.id === id);
      if (!m) throw new UnknownMailboxError(id);
      return m;
    },
    principalEmailAddresses: async () => [
      ...new Set([...mailboxes.map((m) => m.address), ...(opts.identityAddresses ?? [])].map((a) => a.toLowerCase()).filter((a) => a !== '')),
    ],
    defaultMailbox: async () => mailboxes.find((m) => m.isDefault) ?? null,
    credentials: async (id: string) => ({ apiKey: opts.apiKey ?? 'test-api-key', grantId: grantFor(id) }),
  };
  return stub as unknown as NonNullable<ToolContext['principalMailboxes']>;
}

export interface FetchCall { grant: string; method: string; path: string }

/**
 * Two mailboxes, `work` (default, grant `grant-work`) and `personal` (grant `grant-personal`).
 * The object lives only in the mailboxes named in `holders`; every other grant answers 404.
 * Returns the stub ctx fragment and a log of the calls made, by grant.
 */
export function twoMailboxFixture(holders: Array<'work' | 'personal'>) {
  const principalMailboxes = stubPrincipalMailboxes({
    mailboxes: [
      mailboxView('work', 'Work', 'ceo@work.example.com', true),
      mailboxView('personal', 'Personal', 'ceo@personal.example.com'),
    ],
    grantId: (id) => `grant-${id}`,
  });
  const calls: FetchCall[] = [];
  const fetchStub = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const grant = /\/grants\/([^/]+)/.exec(u.pathname)![1]!;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ grant, method, path: u.pathname.replace(/^.*\/grants\/[^/]+/, '') });
    if (!holders.some((h) => `grant-${h}` === grant)) {
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
    }
    if (u.pathname.endsWith('/download')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (u.pathname.includes('/drafts/')) {
      return new Response(JSON.stringify({ data: { id: 'x1', subject: 's', body: '<p>b</p>', to: [], cc: [], bcc: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: {
        id: 'x1', subject: 's', body: '<p>b</p>', folders: ['INBOX'], from: [{ email: 'a@example.com' }], to: [], cc: [],
        attachments: [{ id: 'a1', filename: 'f.txt', content_type: 'text/plain', size: 3 }],
      },
    }), { status: 200 });
  };
  return { principalMailboxes, calls, fetchStub };
}

export interface RawTestMessage { id: string; date: number; unread?: boolean; folders?: string[]; from?: Array<{ email: string }> }

export function rawMessage(id: string, date: number, extra: Partial<RawTestMessage> = {}): Record<string, unknown> {
  return {
    id, threadId: `t-${id}`, date, subject: `subject ${id}`, from: [{ email: `${id}@sender.example.com` }],
    to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [], ...extra,
  };
}

export interface PagedFetchOptions {
  /** Grants that answer HTTP 500. */
  failing?: string[];
  /** Messages per page when the request asks for more than this (default: the request's limit). */
  pageSize?: number;
}

/**
 * A fake Nylas for /messages: each grant serves its list in order, with `next_cursor` = `o<offset>`.
 * Records the query string of every request so tests can check what was re-sent.
 */
export function pagedMessagesFetch(byGrant: Record<string, Array<Record<string, unknown>>>, opts: PagedFetchOptions = {}) {
  const requests: Array<{ grant: string; params: URLSearchParams }> = [];
  const fetchStub = async (url: unknown): Promise<Response> => {
    const u = new URL(String(url));
    const grant = /\/grants\/([^/]+)/.exec(u.pathname)![1]!;
    requests.push({ grant, params: u.searchParams });
    if (opts.failing?.includes(grant)) {
      return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    }
    const all = byGrant[grant] ?? [];
    const token = u.searchParams.get('page_token');
    const offset = token ? Number(token.slice(1)) : 0;
    const size = Math.min(Number(u.searchParams.get('limit') ?? 50), opts.pageSize ?? 50);
    const data = all.slice(offset, offset + size);
    const next = offset + size < all.length ? `o${offset + size}` : undefined;
    return new Response(JSON.stringify({ data, ...(next ? { next_cursor: next } : {}) }), { status: 200 });
  };
  return { requests, fetchStub };
}

export function twoMailboxes() {
  return stubPrincipalMailboxes({
    mailboxes: [
      mailboxView('work', 'Work', 'ceo@work.example.com', true),
      mailboxView('personal', 'Personal', 'ceo@personal.example.com'),
    ],
    grantId: (id) => `grant-${id}`,
  });
}
