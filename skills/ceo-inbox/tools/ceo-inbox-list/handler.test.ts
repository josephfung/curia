import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxListHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { Logger } from '../../../../src/logger.js';
import { TriageState } from '../../../../src/principal-mailboxes/triage-state.js';
import type { DedupeClaim } from '../../../../src/principal-mailboxes/triage-dedupe.js';
import { dueMailboxes } from '../../../../src/principal-mailboxes/triage-due.js';
import { parseCadence, readTriageCadences } from '../../../../src/principal-mailboxes/triage-cadence.js';
import { mailboxView, pagedMessagesFetch, rawMessage, stubPrincipalMailboxes, twoMailboxes, twoMailboxFixture } from '../../../_shared/principal-mailboxes-test-helpers.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal ToolContext. The Nylas client is mocked at the fetch level
 *  so we can inspect the outgoing query params. There is no watermark anymore,
 *  so no entityMemory wiring is needed. */
function makeCtx(
  input: Record<string, unknown>,
  opts: { selfEmail?: string; liveSelfEmails?: string[] } = {},
): ToolContext {
  return {
    input,
    // Curia's own addresses come from its email accounts, not a vault key (#2409).
    selfEmails: opts.selfEmail ? [opts.selfEmail] : [],
    ...(opts.liveSelfEmails ? { curiaEmailAddresses: async () => opts.liveSelfEmails! } : {}),
    principalMailboxes: stubPrincipalMailboxes({ grantId: 'test-grant', apiKey: 'test-key' }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  } as unknown as ToolContext;
}

function mockFetchReturning(messages: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: messages }),
  } as unknown as Response);
}

function fetchedUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
  return new URL(fetchMock.mock.calls[0]![0] as string);
}

/** Build N unread INBOX message summaries from distinct senders. */
function unreadMessages(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    threadId: `t${i}`,
    date: i + 1,
    subject: `subject ${i}`,
    from: [{ email: `s${i}@x.com`, name: `Sender ${i}` }],
    to: [],
    cc: [],
    snippet: '',
    unread: true,
    folders: ['INBOX'],
    attachments: [],
  }));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CeoInboxListHandler — batch listing (no watermark)', () => {
  let handler: CeoInboxListHandler;

  beforeEach(() => {
    handler = new CeoInboxListHandler();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never sends a received_after param (the watermark is gone)', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 5 });
    const fetchSpy = mockFetchReturning(unreadMessages(3));
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    expect(fetchedUrl(fetchSpy).searchParams.get('received_after')).toBeNull();
  });

  it('requests limit+1 from Nylas so it can compute has_more in one round-trip', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 5 });
    const fetchSpy = mockFetchReturning(unreadMessages(3));
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    expect(fetchedUrl(fetchSpy).searchParams.get('limit')).toBe('6');
    expect(fetchedUrl(fetchSpy).searchParams.get('unread')).toBe('true');
  });

  it('returns the full batch and has_more=true when more unread remain', async () => {
    // limit 5 → fetch 6 → Nylas returns 6 → there is a 6th beyond the batch.
    const ctx = makeCtx({ unread_only: true, limit: 5 });
    const fetchSpy = mockFetchReturning(unreadMessages(6));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean };
    expect(data.count).toBe(5);
    expect(data.has_more).toBe(true);
  });

  it('returns has_more=false when the batch is not full', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 5 });
    const fetchSpy = mockFetchReturning(unreadMessages(3));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean };
    expect(data.count).toBe(3);
    expect(data.has_more).toBe(false);
  });

  it('returns has_more=false when exactly `limit` unread exist (the +1 probe came back short)', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 5 });
    const fetchSpy = mockFetchReturning(unreadMessages(5));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean };
    expect(data.count).toBe(5);
    expect(data.has_more).toBe(false);
  });

  it('filters out messages sent from curiaEmail before computing the batch', async () => {
    const self = 'curia@example.com';
    const ctx = makeCtx({ unread_only: true, limit: 5 }, { selfEmail: self });
    const fetchSpy = mockFetchReturning([
      { id: 'm1', threadId: 't1', date: 1, subject: 'a', from: [{ email: self, name: 'Curia' }], to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [] },
      { id: 'm2', threadId: 't2', date: 2, subject: 'b', from: [{ email: 'other@x.com', name: 'Other' }], to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [] },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean };
    expect(data.count).toBe(1);
    expect(data.has_more).toBe(false);
  });

  it('filters a Curia mailbox added in the console since boot (#2409)', async () => {
    // Not in the boot-time selfEmails, only in the live email-accounts read.
    const added = 'sched@example.com';
    const ctx = makeCtx({ unread_only: true, limit: 5 }, { liveSelfEmails: [added] });
    vi.stubGlobal('fetch', mockFetchReturning([
      { id: 'm1', threadId: 't1', date: 1, subject: 'a', from: [{ email: 'Sched@Example.com', name: 'Curia' }], to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [] },
      { id: 'm2', threadId: 't2', date: 2, subject: 'b', from: [{ email: 'other@x.com', name: 'Other' }], to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [] },
    ]));

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { messages: Array<{ id: string }>; count: number };
    expect(data.count).toBe(1);
    expect(data.messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('reports has_more from filtered results when the probe slot is Curia-self and nothing follows', async () => {
    // limit 5 → fetch 6. One of the 6 is Curia-self, so exactly `limit` real
    // messages remain and Nylas reports no further page. has_more follows the
    // filtered set, not the raw probe.
    const self = 'curia@example.com';
    const ctx = makeCtx({ unread_only: true, limit: 5 }, { selfEmail: self });
    const real = unreadMessages(5) as Array<{ from: Array<{ email: string; name: string }> }>;
    const curia = { id: 'mc', threadId: 'tc', date: 99, subject: 'self', from: [{ email: self, name: 'Curia' }], to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [] };
    const fetchSpy = mockFetchReturning([curia, ...real]); // 6 raw, 1 filtered, no cursor
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean };
    expect(data.count).toBe(5);
    expect(data.has_more).toBe(false);
  });

  it('pages past an all-Curia-self page to the next real unread message (#2035)', async () => {
    const self = 'curia@example.com';
    const ctx = makeCtx({ unread_only: true, limit: 5 }, { selfEmail: self });
    const curiaPage = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`, threadId: `tc${i}`, date: i, subject: 'self',
      from: [{ email: self, name: 'Curia' }], to: [], cc: [], snippet: '',
      unread: true, folders: ['INBOX'], attachments: [],
    }));
    const real = {
      id: 'real-1', threadId: 'tr', date: 50, subject: 'from a person',
      from: [{ email: 'person@x.com', name: 'Person' }], to: [], cc: [], snippet: '',
      unread: true, folders: ['INBOX'], attachments: [],
    };
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page_token');
      if (!page) {
        return { ok: true, json: async () => ({ data: curiaPage, next_cursor: 'p2' }) };
      }
      return { ok: true, json: async () => ({ data: [real] }) };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean; messages: Array<{ id: string }> };
    expect(data.count).toBe(1);
    expect(data.has_more).toBe(false);
    expect(data.messages.map((m) => m.id)).toEqual(['real-1']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const second = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(second.searchParams.get('page_token')).toBe('p2');
    // The cursor does not carry the first page's filters, so they are re-sent (#2377).
    expect(second.searchParams.get('in')).toBe('INBOX');
    expect(second.searchParams.get('unread')).toBe('true');
    expect(second.searchParams.get('limit')).toBe('20');
  });

  it('returns count 0 and has_more false when the mailbox of Curia-self mail is exhausted (#2035)', async () => {
    const self = 'curia@example.com';
    const ctx = makeCtx({ unread_only: true, limit: 5 }, { selfEmail: self });
    const curiaPage = (prefix: string) => Array.from({ length: 6 }, (_, i) => ({
      id: `${prefix}${i}`, threadId: `t${prefix}${i}`, date: i, subject: 'self',
      from: [{ email: self, name: 'Curia' }], to: [], cc: [], snippet: '',
      unread: true, folders: ['INBOX'], attachments: [],
    }));
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page_token');
      if (!page) {
        return { ok: true, json: async () => ({ data: curiaPage('a'), next_cursor: 'p2' }) };
      }
      return { ok: true, json: async () => ({ data: curiaPage('b') }) };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean; scan_incomplete?: boolean };
    expect(data.count).toBe(0);
    expect(data.has_more).toBe(false);
    expect(data.scan_incomplete).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(ctx.log.error).not.toHaveBeenCalled();
  });

  it('stops at the page cap and reports scan_incomplete when the cursor never ends (#2035)', async () => {
    const self = 'curia@example.com';
    const ctx = makeCtx({ unread_only: true, limit: 5 }, { selfEmail: self });
    const curiaPage = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`, threadId: `tc${i}`, date: i, subject: 'self',
      from: [{ email: self, name: 'Curia' }], to: [], cc: [], snippet: '',
      unread: true, folders: ['INBOX'], attachments: [],
    }));
    // A fresh cursor every page (a repeated one ends the mailbox, see scanMailbox).
    let page = 0;
    const fetchSpy = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ data: curiaPage, next_cursor: `again-${++page}` }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean; scan_incomplete?: boolean };
    expect(data.count).toBe(0);
    expect(data.has_more).toBe(false);
    expect(data.scan_incomplete).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(25);
    expect(ctx.log.error).toHaveBeenCalled();
    const followUp = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(followUp.searchParams.get('limit')).toBe('20');
  });
});

/** Messages Nylas returns for `in=INBOX&unread=true` that are read and archived (#2377). */
function staleMessages(n: number, prefix = 'old'): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    threadId: `t${prefix}${i}`,
    date: i + 1,
    subject: `handled ${i}`,
    from: [{ email: `s${i}@x.com`, name: `Sender ${i}` }],
    to: [],
    cc: [],
    snippet: '',
    unread: false,
    folders: ['Label_handled'],
    attachments: [],
  }));
}

describe('CeoInboxListHandler — stale provider results (#2377)', () => {
  let handler: CeoInboxListHandler;

  beforeEach(() => {
    handler = new CeoInboxListHandler();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports count 0 and has_more false when the provider returns only stale entries', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 5 });
    const fetchSpy = mockFetchReturning(staleMessages(6));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean };
    expect(data.count).toBe(0);
    expect(data.has_more).toBe(false);
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: 6 }),
      expect.any(String),
    );
  });

  it('drops a message that is read, and one that is unread but no longer in INBOX', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 5 });
    const [real] = unreadMessages(1) as Array<Record<string, unknown>>;
    const readInInbox = { ...real, id: 'read', unread: false, folders: ['INBOX'] };
    const unreadArchived = { ...real, id: 'archived', unread: true, folders: ['UNREAD'] };
    const fetchSpy = mockFetchReturning([readInInbox, unreadArchived, real]);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean; messages: Array<{ id: string }> };
    expect(data.messages.map((m) => m.id)).toEqual(['m0']);
    expect(data.has_more).toBe(false);
  });

  it('keeps real unread mail mixed in with stale entries and computes has_more from it', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 2 });
    // limit 2 → fetch 3. Two stale + one real, no further page.
    const fetchSpy = mockFetchReturning([...staleMessages(2), ...unreadMessages(1)]);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean; messages: Array<{ id: string; unread: boolean }> };
    expect(data.count).toBe(1);
    expect(data.has_more).toBe(false);
    expect(data.messages.every((m) => m.unread)).toBe(true);
  });

  it('pages past a full page of stale entries to reach real mail on the next page', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 5 });
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page_token');
      if (!page) {
        return { ok: true, json: async () => ({ data: staleMessages(6), next_cursor: 'p2' }) };
      }
      return { ok: true, json: async () => ({ data: unreadMessages(2) }) };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean; messages: Array<{ id: string }> };
    expect(data.messages.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(data.has_more).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps read messages when unread_only is false', async () => {
    const ctx = makeCtx({ unread_only: false, limit: 5 });
    const [real] = unreadMessages(1) as Array<Record<string, unknown>>;
    const fetchSpy = mockFetchReturning([{ ...real, unread: false }]);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    expect((result.data as { count: number }).count).toBe(1);
  });

  it('skips the folder check for a user label, whose folder ID is opaque', async () => {
    const ctx = makeCtx({ unread_only: true, limit: 5, folder: 'Receipts' });
    const [real] = unreadMessages(1) as Array<Record<string, unknown>>;
    const fetchSpy = mockFetchReturning([{ ...real, folders: ['Label_42'] }]);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    expect((result.data as { count: number }).count).toBe(1);
  });
});

describe('CeoInboxListHandler — drafts routing (#1000)', () => {
  let handler: CeoInboxListHandler;

  beforeEach(() => {
    handler = new CeoInboxListHandler();
  });

  it('routes folder DRAFTS to the /drafts resource, not /messages', async () => {
    const ctx = makeCtx({ folder: 'DRAFTS' });
    const fetchSpy = mockFetchReturning([]);
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    const url = fetchedUrl(fetchSpy);
    expect(url.pathname.endsWith('/drafts')).toBe(true);
    expect(url.pathname).not.toContain('/messages');
  });

  it('also routes the DRAFT alias to /drafts', async () => {
    const ctx = makeCtx({ folder: 'DRAFT' });
    const fetchSpy = mockFetchReturning([]);
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    expect(fetchedUrl(fetchSpy).pathname.endsWith('/drafts')).toBe(true);
  });

  // Drafts never use Curia's addresses, so a slow accounts read must not hold the branch up.
  it('does not look up Curia addresses for a drafts listing', async () => {
    const lookup = vi.fn(async () => ['curia@example.com']);
    const ctx = { ...makeCtx({ folder: 'DRAFTS' }), curiaEmailAddresses: lookup } as ToolContext;
    vi.stubGlobal('fetch', mockFetchReturning([]));

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns drafts under a `drafts` key, distinguishable from the messages path', async () => {
    const raw = [
      { id: 'd1', thread_id: 't1', subject: 'Hi', to: [{ email: 'a@b.com' }], cc: [], snippet: 's', date: 5 },
    ];
    const ctx = makeCtx({ folder: 'DRAFTS' });
    const fetchSpy = mockFetchReturning(raw);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`expected success: ${result.error}`);
    const data = result.data as { drafts: Array<Record<string, unknown>>; count: number; folder: string };
    expect(data.folder).toBe('DRAFTS');
    expect(data.count).toBe(1);
    expect(data.drafts).toHaveLength(1);
    expect(data.drafts[0]).toMatchObject({ id: 'd1', subject: 'Hi' });
  });
});

describe('CeoInboxListHandler — drafts date filter and authorship (#2474)', () => {
  const handler = new CeoInboxListHandler();
  // 2026-11-07T13:00:00Z = 08:00 in Toronto; d1 is before, d2 and d3 at/after.
  const RAW = [
    { id: 'd1', thread_id: 't1', subject: 'old', to: [], cc: [], snippet: '', date: 1794056400 - 3600 },
    { id: 'd2', thread_id: 't2', subject: 'edge', to: [], cc: [], snippet: '', date: 1794056400 },
    { id: 'd3', thread_id: 't3', subject: 'new', to: [], cc: [], snippet: '', date: 1794056400 + 3600 },
  ];
  const SINCE = '2026-11-07T08:00:00-05:00';
  const repo = (rows: unknown[] | Error) => ({
    findToolResults: rows instanceof Error ? vi.fn().mockRejectedValue(rows) : vi.fn().mockResolvedValue(rows),
    findToolResultsForTasks: vi.fn(),
  });
  const ctxWith = (input: Record<string, unknown>, auditLogRepo: unknown) =>
    ({ ...makeCtx({ ...input }), timezone: 'America/Toronto', auditLogRepo }) as unknown as ToolContext;

  afterEach(() => { vi.unstubAllGlobals(); });

  it('filters drafts by modified_since', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS', modified_since: SINCE }, repo([])));
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Array<{ id: string }>; count: number };
    expect(data.drafts.map((d) => d.id)).toEqual(['d2', 'd3']);
    expect(data.count).toBe(2);
  });

  it('pages past the first 20 drafts with modified_since (final review C1)', async () => {
    // Page 1: 20 old drafts and a cursor; page 2: this morning's draft.
    const old = Array.from({ length: 20 }, (_, i) => ({ id: `old${i}`, thread_id: `t${i}`, subject: 'old', to: [], cc: [], snippet: '', date: 1794056400 - 86_400 }));
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: old, next_cursor: 'c2' }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [RAW[2]] }) } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS', modified_since: SINCE }, repo([])));
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Array<{ id: string }>; scan_incomplete?: boolean };
    expect(data.drafts.map((d) => d.id)).toEqual(['d3']);
    expect(data.scan_incomplete).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('says scan_incomplete when the draft scan stops at its cap (final review C1)', async () => {
    let n = 0;
    const page = () => Array.from({ length: 20 }, () => ({ id: `x${n++}`, thread_id: 't', subject: 's', to: [], cc: [], snippet: '', date: 1794056400 + 60 }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: page(), next_cursor: 'more' }) }) as unknown as Response));
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS', modified_since: SINCE }, repo([])));
    if (!result.success) throw new Error(result.error);
    expect((result.data as { scan_incomplete?: boolean }).scan_incomplete).toBe(true);
  });

  it('rejects an unparseable modified_since with an error naming the field', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS', modified_since: 'this morning' }, repo([])));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('modified_since');
  });

  it('marks created_by_curia from provenance', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    const rows = [{
      timestamp: new Date(), targetId: 'ceo-inbox-draft-reply',
      payload: { toolName: 'ceo-inbox-draft-reply', result: { success: true, data: { draft_id: 'd3' } } },
    }];
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS' }, repo(rows)));
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Array<{ id: string; created_by_curia: boolean | null }> };
    expect(data.drafts.map((d) => [d.id, d.created_by_curia])).toEqual([['d1', false], ['d2', false], ['d3', true]]);
  });

  it('sets created_by_curia null and still lists when provenance throws', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS' }, repo(new Error('db down'))));
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Array<{ created_by_curia: boolean | null }>; count: number };
    expect(data.count).toBe(3);
    expect(data.drafts.every((d) => d.created_by_curia === null)).toBe(true);
  });

  it('adds date_local and displayTimezone', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS' }, repo([])));
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Array<{ id: string; date_local: string }>; displayTimezone: string };
    expect(data.drafts.find((d) => d.id === 'd2')!.date_local).toMatch(/^2026-11-07T08:00:00\.000-05:00/);
    expect(data.displayTimezone).toContain('EST');
  });

  it('reads an offset-less modified_since in the principal timezone', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    // 08:00 Toronto = 13:00Z, so d1 (an hour earlier) is out and d2/d3 are in; UTC reading would keep none.
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS', modified_since: '2026-11-07T08:00:00' }, repo([])));
    if (!result.success) throw new Error(result.error);
    expect((result.data as { drafts: Array<{ id: string }> }).drafts.map((d) => d.id)).toEqual(['d2', 'd3']);
  });

  it('leaves an explicit-offset modified_since unchanged', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS', modified_since: '2026-11-07T14:00:00Z' }, repo([])));
    if (!result.success) throw new Error(result.error);
    expect((result.data as { drafts: Array<{ id: string }> }).drafts.map((d) => d.id)).toEqual(['d3']);
  });

  it('sets created_by_curia null when no auditLogRepo is available', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS' }, undefined));
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Array<{ created_by_curia: boolean | null }>; count: number };
    expect(data.count).toBe(3);
    expect(data.drafts.every((d) => d.created_by_curia === null)).toBe(true);
  });
});

describe('CeoInboxListHandler — mailbox input (#2475)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses an unknown mailbox id instead of using the default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await new CeoInboxListHandler().execute(makeCtx({ mailbox: 'nope' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('nope');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acts in the named mailbox when it is live', async () => {
    const f = twoMailboxFixture(['personal']);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const r = await f.fetchStub(url, init);
      return new Response(JSON.stringify({ data: [] }), { status: r.status });
    });
    const ctx = { ...makeCtx({ mailbox: 'personal' }), principalMailboxes: f.principalMailboxes } as ToolContext;
    const result = await new CeoInboxListHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect(f.calls.every((c) => c.grant === 'grant-personal')).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('CeoInboxListHandler — every mailbox (#2475)', () => {
  afterEach(() => vi.restoreAllMocks());

  const ctxFor = (input: Record<string, unknown>): ToolContext =>
    ({ ...makeCtx(input), principalMailboxes: twoMailboxes() }) as ToolContext;
  type Item = { id: string; mailbox: string; mailbox_label: string };
  type Data = { messages: Item[]; count: number; has_more: boolean; next_page_token?: string; mailbox_errors?: Array<{ mailbox: string; mailbox_label: string; error: string }> };

  function serve(byGrant: Record<string, Array<Record<string, unknown>>>, opts: Parameters<typeof pagedMessagesFetch>[1] = {}) {
    const f = pagedMessagesFetch(byGrant, opts);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => f.fetchStub(url));
    return f;
  }
  const run = (input: Record<string, unknown>) => new CeoInboxListHandler().execute(ctxFor(input));

  it('merges two mailboxes by date and labels each', async () => {
    serve({
      'grant-work': [rawMessage('w1', 100), rawMessage('w2', 96)],
      'grant-personal': [rawMessage('p1', 98), rawMessage('p2', 94)],
    });
    const result = await run({ limit: 10 });
    if (!result.success) throw new Error(result.error);
    const data = result.data as Data;
    expect(data.messages.map((m) => [m.id, m.mailbox, m.mailbox_label])).toEqual([
      ['w1', 'work', 'Work'], ['p1', 'personal', 'Personal'], ['w2', 'work', 'Work'], ['p2', 'personal', 'Personal'],
    ]);
    expect(data.has_more).toBe(false);
    expect(data.next_page_token).toBeUndefined();
    expect(data.mailbox_errors).toBeUndefined();
  });

  it('breaks date ties by mailbox id then message id', async () => {
    serve({
      'grant-work': [rawMessage('b', 50), rawMessage('a', 50)],
      'grant-personal': [rawMessage('z', 50)],
    });
    const result = await run({ limit: 10 });
    if (!result.success) throw new Error(result.error);
    expect((result.data as Data).messages.map((m) => m.id)).toEqual(['z', 'b', 'a']);
  });

  it('a failing mailbox is reported and does not hide the other', async () => {
    serve({ 'grant-work': [rawMessage('w1', 100)], 'grant-personal': [rawMessage('p1', 98)] }, { failing: ['grant-personal'] });
    const result = await run({ limit: 10 });
    if (!result.success) throw new Error(result.error);
    const data = result.data as Data;
    expect(data.messages.map((m) => m.id)).toEqual(['w1']);
    expect(data.mailbox_errors).toEqual([{ mailbox: 'personal', mailbox_label: 'Personal', error: 'HTTP 500', note: expect.stringContaining('later call retries') }]);
    expect(JSON.stringify(result)).not.toContain('grant-');
  });

  it('fails when every mailbox fails', async () => {
    serve({}, { failing: ['grant-work', 'grant-personal'] });
    const result = await run({ limit: 10 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).not.toContain('grant-');
  });

  it('explicit mailbox reads only that mailbox', async () => {
    const f = serve({ 'grant-work': [rawMessage('w1', 100)], 'grant-personal': [rawMessage('p1', 98)] });
    const result = await run({ limit: 10, mailbox: 'personal' });
    if (!result.success) throw new Error(result.error);
    expect((result.data as Data).messages.map((m) => m.id)).toEqual(['p1']);
    expect(f.requests.every((r) => r.grant === 'grant-personal')).toBe(true);
  });

  it('DRAFTS lists drafts from every mailbox, labelled', async () => {
    const draft = (id: string, date: number) => ({ id, thread_id: `t${id}`, subject: id, to: [], cc: [], snippet: '', date });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const grant = /\/grants\/([^/]+)/.exec(new URL(String(url)).pathname)![1]!;
      const data = grant === 'grant-work' ? [draft('dw', 10)] : [draft('dp', 20)];
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const result = await run({ folder: 'DRAFTS', limit: 10 });
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Item[]; count: number };
    expect(data.drafts.map((d) => [d.id, d.mailbox, d.mailbox_label])).toEqual([
      ['dp', 'personal', 'Personal'], ['dw', 'work', 'Work'],
    ]);
  });

  it('pages through two mailboxes to the end and returns every message exactly once', async () => {
    const work = Array.from({ length: 9 }, (_, i) => rawMessage(`w${i}`, 200 - i * 7));
    const personal = Array.from({ length: 8 }, (_, i) => rawMessage(`p${i}`, 203 - i * 5));
    // A second page request for a mailbox whose items were cut must resume mid-page.
    const f = serve({ 'grant-work': work, 'grant-personal': personal }, { pageSize: 4 });

    const seen: string[] = [];
    let token: string | undefined;
    for (let call = 0; call < 20; call++) {
      const result = await run({ limit: 3, ...(token ? { page_token: token } : {}) });
      if (!result.success) throw new Error(result.error);
      const data = result.data as Data;
      expect(data.count).toBeLessThanOrEqual(3);
      seen.push(...data.messages.map((m) => m.id));
      token = data.next_page_token;
      expect(data.has_more).toBe(token !== undefined);
      if (!token) break;
    }
    expect(token).toBeUndefined();
    expect([...seen].sort()).toEqual([...work, ...personal].map((m) => m.id as string).sort());
    expect(new Set(seen).size).toBe(seen.length);
    // Merged order is date descending across pages.
    const dates = new Map([...work, ...personal].map((m) => [m.id as string, m.date as number]));
    const ordered = seen.map((id) => dates.get(id)!);
    expect(ordered).toEqual([...ordered].sort((a, b) => b - a));
    // Every cursor request re-sends the filters (#2377).
    const cursorRequests = f.requests.filter((r) => r.params.get('page_token'));
    expect(cursorRequests.length).toBeGreaterThan(0);
    for (const r of cursorRequests) {
      expect(r.params.get('in')).toBe('INBOX');
      expect(r.params.get('unread')).toBe('true');
    }
  });

  it('does not skip mail when the previous page was triaged out of the unread list', async () => {
    const work = Array.from({ length: 6 }, (_, i) => rawMessage(`w${i}`, 100 - i));
    serve({ 'grant-work': work });
    const first = await run({ limit: 2, mailbox: 'work' });
    if (!first.success) throw new Error(first.error);
    expect((first.data as Data).messages.map((m) => m.id)).toEqual(['w0', 'w1']);
    // Triage archives or reads the first page: it leaves the unread-INBOX listing.
    work.splice(0, 2);
    const second = await run({ limit: 2, mailbox: 'work', page_token: (first.data as Data).next_page_token });
    if (!second.success) throw new Error(second.error);
    expect((second.data as Data).messages.map((m) => m.id)).toEqual(['w2', 'w3']);
  });

  it('does not skip mail when triage removes more than a provider page between calls', async () => {
    const work = Array.from({ length: 10 }, (_, i) => rawMessage(`w${i}`, 100 - i));
    // Offset cursors with 2-item pages: removing four messages shifts every later page by two.
    serve({ 'grant-work': work }, { pageSize: 2 });
    const first = await run({ limit: 4, mailbox: 'work' });
    if (!first.success) throw new Error(first.error);
    expect((first.data as Data).messages.map((m) => m.id)).toEqual(['w0', 'w1', 'w2', 'w3']);
    work.splice(0, 4);
    const second = await run({ limit: 4, mailbox: 'work', page_token: (first.data as Data).next_page_token });
    if (!second.success) throw new Error(second.error);
    expect((second.data as Data).messages.map((m) => m.id)).toEqual(['w4', 'w5', 'w6', 'w7']);
  });

  it('pages without repeats when nothing leaves the listing between calls', async () => {
    const work = Array.from({ length: 9 }, (_, i) => rawMessage(`w${i}`, 100 - i));
    const f = serve({ 'grant-work': work }, { pageSize: 2 });
    const seen: string[] = [];
    let token: string | undefined;
    for (let call = 0; call < 10; call++) {
      const result = await run({ limit: 2, mailbox: 'work', ...(token ? { page_token: token } : {}) });
      if (!result.success) throw new Error(result.error);
      seen.push(...(result.data as Data).messages.map((m) => m.id));
      token = (result.data as Data).next_page_token;
      if (!token) break;
    }
    expect(seen).toEqual(work.map((m) => m.id));
    expect(f.requests.length).toBeLessThan(40);
  });

  it('a failed mailbox does not keep has_more set once the readable one is finished', async () => {
    // The unread drain re-lists from the top after every batch, which retries the failed mailbox;
    // has_more here would wake the drain again for a mailbox that is still failing (#2035).
    serve({ 'grant-work': [rawMessage('w1', 100)] }, { failing: ['grant-personal'] });
    const result = await run({ limit: 10 });
    if (!result.success) throw new Error(result.error);
    const data = result.data as Data;
    expect(data.has_more).toBe(false);
    expect(data.next_page_token).toBeUndefined();
    expect(data.mailbox_errors?.[0]).toMatchObject({ mailbox: 'personal', note: expect.stringContaining('later call retries') });
  });

  it('keeps reading past an empty page that still has a next cursor', async () => {
    const pages: Record<string, { data: Array<Record<string, unknown>>; next?: string }> = {
      '': { data: [], next: 'c1' },
      c1: { data: [rawMessage('w1', 100), rawMessage('w2', 99)] },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const page = pages[new URL(String(url)).searchParams.get('page_token') ?? '']!;
      return new Response(JSON.stringify({ data: page.data, ...(page.next ? { next_cursor: page.next } : {}) }), { status: 200 });
    });
    const result = await run({ limit: 5, mailbox: 'work' });
    if (!result.success) throw new Error(result.error);
    expect((result.data as Data).messages.map((m) => m.id)).toEqual(['w1', 'w2']);
  });

  it('refuses a page_token when the mailbox selection changed', async () => {
    serve({ 'grant-work': Array.from({ length: 6 }, (_, i) => rawMessage(`w${i}`, 100 - i)) });
    const first = await run({ limit: 2, mailbox: 'work' });
    if (!first.success) throw new Error(first.error);
    const second = await run({ limit: 2, page_token: (first.data as Data).next_page_token });
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain('without page_token');
  });

  it('refuses a page_token made for another folder or unread filter', async () => {
    serve({ 'grant-work': Array.from({ length: 6 }, (_, i) => rawMessage(`w${i}`, 100 - i)) });
    const first = await run({ limit: 2, mailbox: 'work' });
    if (!first.success) throw new Error(first.error);
    const token = (first.data as Data).next_page_token!;
    const second = await run({ limit: 2, mailbox: 'work', unread_only: false, page_token: token });
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain('other filters');
  });

  it('an explicit mailbox still pages with a composite token holding one key', async () => {
    serve({ 'grant-personal': Array.from({ length: 5 }, (_, i) => rawMessage(`p${i}`, 100 - i)) }, { pageSize: 3 });
    const first = await run({ limit: 2, mailbox: 'personal' });
    if (!first.success) throw new Error(first.error);
    const token = (first.data as Data).next_page_token!;
    expect(Object.keys(JSON.parse(Buffer.from(token, 'base64url').toString()).mailboxes)).toEqual(['personal']);
    const second = await run({ limit: 2, mailbox: 'personal', page_token: token });
    if (!second.success) throw new Error(second.error);
    expect((second.data as Data).messages.map((m) => m.id)).toEqual(['p2', 'p3']);
  });

  it('a single-mailbox install labels items and issues a composite token', async () => {
    const f = pagedMessagesFetch({ 'test-grant': Array.from({ length: 4 }, (_, i) => rawMessage(`m${i}`, 10 - i)) });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => f.fetchStub(url));
    const result = await new CeoInboxListHandler().execute(makeCtx({ limit: 2 }));
    if (!result.success) throw new Error(result.error);
    const data = result.data as Data;
    expect(data.messages.map((m) => [m.id, m.mailbox])).toEqual([['m0', 'work'], ['m1', 'work']]);
    expect(Object.keys(JSON.parse(Buffer.from(data.next_page_token!, 'base64url').toString()).mailboxes)).toEqual(['work']);
  });

  it('refuses a page_token it cannot decode and says to retry without it', async () => {
    const f = serve({ 'grant-work': [rawMessage('w1', 1)] });
    const result = await run({ page_token: 'a-raw-nylas-cursor' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('without page_token');
    expect(f.requests).toHaveLength(0);
  });

  it('refuses a page_token made at another limit, without fetching', async () => {
    const f = serve({ 'grant-work': Array.from({ length: 6 }, (_, i) => rawMessage(`w${i}`, 100 - i)) }, { pageSize: 3 });
    const first = await run({ limit: 2 });
    if (!first.success) throw new Error(first.error);
    const token = (first.data as Data).next_page_token!;
    const before = f.requests.length;
    const second = await run({ limit: 3, page_token: token });
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain('the page size changed');
    expect(f.requests).toHaveLength(before);
  });

  it('refuses an explicit mailbox that the page_token does not contain', async () => {
    const f = serve({ 'grant-work': Array.from({ length: 6 }, (_, i) => rawMessage(`w${i}`, 100 - i)) }, { pageSize: 3 });
    const first = await run({ limit: 2, mailbox: 'work' });
    if (!first.success) throw new Error(first.error);
    const token = (first.data as Data).next_page_token!;
    const before = f.requests.length;
    const second = await run({ limit: 2, mailbox: 'personal', page_token: token });
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain('without page_token');
    expect(f.requests).toHaveLength(before);
  });
});

// ── Triage mode (#2475, D4, Task 25) ────────────────────────────────────────

describe('CeoInboxListHandler — triage mode (#2475)', () => {
  const NOW = new Date('2026-11-12T15:00:00Z');
  const NOW_S = Math.floor(NOW.getTime() / 1000);
  const WORK_ADDR = 'ceo@work.example.com';
  const PERSONAL_ADDR = 'ceo@personal.example.com';

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  type Msg = Record<string, unknown>;
  const msg = (id: string, date: number, extra: Record<string, unknown> = {}): Msg => rawMessage(id, date, extra as never);

  /** An in-memory ConfigStore stand-in for the real TriageState. */
  function memoryState() {
    const data = new Map<string, string>();
    const cfg = {
      get: async (_ns: string, key: string) => data.get(key) ?? null,
      set: async (_ns: string, key: string, value: string) => { data.set(key, value); },
    };
    return { data, state: new TriageState(cfg as never, () => 'UTC') };
  }

  interface Opts {
    claim?: (header: string, mailboxId: string, id: string) => Promise<DedupeClaim>;
    cadence?: string;
    start?: { personal?: Date | null; work?: Date | null };
    headers?: Record<string, Array<{ name: string; value: string }> | Error>;
    ctxExtra?: Partial<ToolContext>;
    pageSize?: number;
    failList?: boolean;
    tz?: string;
    /** Writes (by method and path) that answer HTTP 500. */
    failWrite?: (method: string, path: string) => boolean;
  }

  function setup(byGrant: Record<string, Msg[]>, opts: Opts = {}) {
    const { data, state } = memoryState();
    const claim = vi.fn(opts.claim ?? (async () => ({ first: true } as DedupeClaim)));
    const setTriageStart = vi.fn(async () => undefined);
    const cadence = opts.cadence ?? 'every 15m';
    const services = {
      cadences: async (ids: string[]) => readTriageCadences(JSON.stringify(Object.fromEntries(ids.map((i) => [i, cadence]))), ids),
      state, dedupe: { claim }, setTriageStart, tz: () => opts.tz ?? 'UTC',
    };
    const getMessage = vi.fn(async (id: string) => {
      const h = opts.headers?.[id];
      if (h instanceof Error) throw h;
      return { id, headers: h ?? [] };
    });
    const gw = { getMessage };
    const principalMailboxes = stubPrincipalMailboxes({
      mailboxes: [
        { ...mailboxView('work', 'Work', WORK_ADDR, true), triageStartAt: opts.start?.work ?? null },
        { ...mailboxView('personal', 'Personal', PERSONAL_ADDR), triageStartAt: opts.start?.personal ?? null },
      ],
      grantId: (id) => `grant-${id}`,
      gatewayClients: { work: gw, personal: gw },
    });
    const paged = pagedMessagesFetch(byGrant, { pageSize: opts.pageSize ?? 20 });
    const writes: Array<{ grant: string; method: string; path: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = new URL(String(url));
      const method = (init?.method ?? 'GET').toUpperCase();
      const grant = /\/grants\/([^/]+)/.exec(u.pathname)![1]!;
      const path = u.pathname.replace(/^.*\/grants\/[^/]+/, '');
      if (path === '/messages' && method === 'GET') return opts.failList ? new Response('{}', { status: 500 }) : paged.fetchStub(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ grant, method, path, body });
      if (opts.failWrite?.(method, path)) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
      if (path === '/folders' && method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'INBOX', name: 'INBOX' }] }), { status: 200 });
      if (path === '/folders') return new Response(JSON.stringify({ data: { id: 'Label_9', name: body.name } }), { status: 200 });
      return new Response(JSON.stringify({ data: { id: path.split('/').pop(), folders: ['INBOX'], from: [], to: [], cc: [], unread: false, attachments: [] } }), { status: 200 });
    });
    const run = (input: Record<string, unknown> = { triage: true }, extra: Partial<ToolContext> = {}) =>
      new CeoInboxListHandler().execute({
        ...makeCtx(input), principalMailboxes, triageServices: services, timezone: 'UTC', taskMetadata: drainTurn, ...opts.ctxExtra, ...extra,
      } as unknown as ToolContext);
    return { run, data, state, claim, setTriageStart, getMessage, writes, requests: paged.requests };
  }

  type TriageData = {
    messages: Array<{ id: string; mailbox: string; mailbox_label: string; from_principal_other_mailbox?: boolean }>;
    count: number; has_more: boolean; mailboxes_due: string[];
    backlog?: Array<{ mailbox: string; mailbox_label: string; untriaged_over: number }>;
    budget_exhausted?: true; mailbox_errors?: unknown[];
  };
  const dataOf = (r: Awaited<ReturnType<CeoInboxListHandler['execute']>>): TriageData => {
    if (!r.success) throw new Error(r.error);
    return r.data as TriageData;
  };
  const drainTurn = { originator: { systemRole: 'system' }, boundTask: { taskId: 't1', tags: ['inbox-drain'] } };
  const principalTurn = { liveTurn: true, taskMetadata: { originator: { systemRole: 'principal', channel: 'signal' } } } as Partial<ToolContext>;

  it('round-robins across due mailboxes', async () => {
    const t = setup({
      'grant-work': [1, 2, 3, 4, 5, 6].map((i) => msg(`w${i}`, NOW_S - i)),
      'grant-personal': [1, 2, 3].map((i) => msg(`p${i}`, NOW_S - i)),
    });
    const d = dataOf(await t.run());
    expect(d.messages.map((m) => m.id)).toEqual(['w1', 'p1', 'w2', 'p2', 'w3']);
    expect(d.messages.map((m) => m.mailbox_label)).toEqual(['Work', 'Personal', 'Work', 'Personal', 'Work']);
    expect(d.mailboxes_due).toEqual(['work', 'personal']);
    expect(d.has_more).toBe(true);
    expect(await t.state.isDraining('work')).toBe(true);
  });

  it('ignores mail before the start line', async () => {
    const start = new Date((NOW_S - 100) * 1000);
    const t = setup({
      'grant-work': [msg('w1', NOW_S - 500)],
      'grant-personal': [msg('p-new', NOW_S - 10), msg('p-old', NOW_S - 500)],
    }, { start: { personal: start } });
    const d = dataOf(await t.run());
    expect(d.messages.map((m) => m.id).sort()).toEqual(['p-new', 'w1']);
    const personal = t.requests.find((r) => r.grant === 'grant-personal')!;
    expect(personal.params.get('received_after')).toBe(String(NOW_S - 100));
    expect(t.requests.find((r) => r.grant === 'grant-work')!.params.get('received_after')).toBeNull();
  });

  it('sweep_since moves the start line on a principal turn only', async () => {
    const start = new Date('2026-11-10T00:00:00Z');
    const t = setup({ 'grant-personal': [] }, { start: { personal: start } });
    const refused = await t.run({ sweep_since: '2026-11-01', mailbox: 'personal' });
    expect(refused.success).toBe(false);
    // A live turn that is not the principal's is refused too.
    expect((await t.run({ sweep_since: '2026-11-01', mailbox: 'personal' }, { liveTurn: true, taskMetadata: {} })).success).toBe(false);
    expect(t.setTriageStart).not.toHaveBeenCalled();
    const ok = await t.run({ sweep_since: '2026-11-01', mailbox: 'personal' }, principalTurn);
    expect(ok.success).toBe(true);
    expect(t.setTriageStart).toHaveBeenCalledWith('personal', new Date('2026-11-01T00:00:00Z'));
    expect(await t.state.isDraining('personal')).toBe(true);
    expect(await t.state.drainStartedAt('personal')).toEqual(NOW);
  });

  it('sweep_since keeps the start of a drain already running (P6, R52)', async () => {
    const start = new Date('2026-11-10T00:00:00Z');
    const t = setup({ 'grant-personal': [] }, { start: { personal: start } });
    const began = new Date(NOW.getTime() - 40 * 60_000);
    await t.state.setDraining('personal', true);
    await t.state.setDrainStartedAt('personal', began);
    expect((await t.run({ sweep_since: '2026-11-01', mailbox: 'personal' }, principalTurn)).success).toBe(true);
    expect(await t.state.isDraining('personal')).toBe(true);
    expect(await t.state.drainStartedAt('personal')).toEqual(began);
  });

  it('sweep_since is validated: needs a mailbox, a real past date within a year, and an existing start line', async () => {
    const start = new Date('2026-11-10T00:00:00Z');
    const t = setup({ 'grant-personal': [], 'grant-work': [] }, { start: { personal: start } });
    const bad = async (input: Record<string, unknown>) => (await t.run(input, principalTurn)).success;
    expect(await bad({ sweep_since: '2026-11-01' })).toBe(false); // no mailbox
    expect(await bad({ sweep_since: 'last week', mailbox: 'personal' })).toBe(false);
    expect(await bad({ sweep_since: '2026-12-25', mailbox: 'personal' })).toBe(false); // future
    expect(await bad({ sweep_since: '2025-01-01', mailbox: 'personal' })).toBe(false); // over a year
    expect(await bad({ sweep_since: '2026-11-11', mailbox: 'personal' })).toBe(false); // not earlier than the start line
    expect(await bad({ sweep_since: '2026-11-01', mailbox: 'work' })).toBe(false); // work has no start line
    expect(await bad({ sweep_since: '2026-11-01', mailbox: 'nope' })).toBe(false);
    expect(t.setTriageStart).not.toHaveBeenCalled();
  });

  it('backlog alarm once per episode', async () => {
    const many = Array.from({ length: 130 }, (_, i) => msg(`w${i}`, NOW_S - i));
    const t = setup({ 'grant-work': many, 'grant-personal': [] });
    const first = dataOf(await t.run());
    expect(first.backlog).toEqual([{ mailbox: 'work', mailbox_label: 'Work', untriaged_over: 100 }]);
    expect(await t.state.backlogAlarmed('work')).toBe(true);
    const second = dataOf(await t.run());
    expect(second.backlog).toBeUndefined();
  });

  it('the backlog alarm resets when the backlog is cleared', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)], 'grant-personal': [] });
    await t.state.setBacklogAlarmed('work', true);
    dataOf(await t.run());
    expect(await t.state.backlogAlarmed('work')).toBe(false);
  });

  it('budget_exhausted at the ceiling with an empty batch', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)] });
    t.data.set('triage.batches.2026-11-12', '120');
    const d = dataOf(await t.run());
    expect(d).toMatchObject({ messages: [], count: 0, has_more: false, budget_exhausted: true });
    expect(t.requests).toHaveLength(0);
    expect(t.data.get('triage.batches.2026-11-12')).toBe('120');
  });

  it('the second copy of a message is marked read and labelled', async () => {
    const t = setup({
      'grant-work': [],
      'grant-personal': [msg('copy', NOW_S - 1, { to: [{ email: WORK_ADDR }] }), msg('solo', NOW_S - 2)],
    }, {
      headers: { copy: [{ name: 'Message-ID', value: '<abc@mail.example.org>' }] },
      claim: async () => ({ first: false, mailboxId: 'work', nylasMessageId: 'w-copy' }),
    });
    const d = dataOf(await t.run());
    expect(d.messages.map((m) => m.id)).toEqual(['solo']);
    expect(t.claim).toHaveBeenCalledWith('abc@mail.example.org', 'copy@sender.example.com', 'personal', 'copy');
    expect(t.getMessage).toHaveBeenCalledTimes(1); // only the message naming the other address pays
    const personalWrites = t.writes.filter((w) => w.grant === 'grant-personal');
    expect(personalWrites.some((w) => w.method === 'PUT' && w.path === '/messages/copy' && (w.body as { unread?: boolean }).unread === false)).toBe(true);
    expect(personalWrites.some((w) => w.method === 'POST' && w.path === '/folders' && (w.body as { name: string }).name === '↔ In Work')).toBe(true);
    expect(personalWrites.some((w) => w.method === 'PUT' && w.path === '/messages/copy' && JSON.stringify(w.body).includes('Label_9'))).toBe(true);
    expect(t.writes.some((w) => w.grant === 'grant-work')).toBe(false);
  });

  it('claims the first <id> of a Message-ID header that carries more than one token (P5)', async () => {
    const t = setup({
      'grant-work': [],
      'grant-personal': [msg('copy', NOW_S - 1, { to: [{ email: WORK_ADDR }] })],
    }, { headers: { copy: [{ name: 'message-id', value: ' <First@Mail.example.org> (relay) <second@mail.example.org>' }] } });
    dataOf(await t.run());
    expect(t.claim).toHaveBeenCalledTimes(1);
    expect(t.claim.mock.calls[0]![0]).toBe('First@Mail.example.org'); // TriageDedupe lowercases
  });

  it('does not dedupe a message whose Message-ID header holds no <id> (P5)', async () => {
    const t = setup({
      'grant-work': [],
      'grant-personal': [msg('copy', NOW_S - 1, { to: [{ email: WORK_ADDR }] })],
    }, { headers: { copy: [{ name: 'Message-ID', value: 'not-an-id' }] } });
    expect(dataOf(await t.run()).messages.map((m) => m.id)).toEqual(['copy']);
    expect(t.claim).not.toHaveBeenCalled();
  });

  it('keeps a message in the batch when its headers cannot be fetched', async () => {
    const t = setup({
      'grant-work': [],
      'grant-personal': [msg('copy', NOW_S - 1, { to: [{ email: WORK_ADDR }] })],
    }, { headers: { copy: new Error('boom grant-personal') } });
    const d = dataOf(await t.run());
    expect(d.messages.map((m) => m.id)).toEqual(['copy']);
    expect(t.claim).not.toHaveBeenCalled();
    expect(t.writes).toHaveLength(0);
  });

  it('keeps a cross-mailbox message with no From address in the batch without claiming it (P6)', async () => {
    const t = setup({
      'grant-work': [],
      'grant-personal': [msg('nofrom', NOW_S - 1, { from: [], to: [{ email: WORK_ADDR }] })],
    }, { headers: { nofrom: [{ name: 'Message-ID', value: '<nofrom@mail.example.org>' }] } });
    expect(dataOf(await t.run()).messages.map((m) => m.id)).toEqual(['nofrom']);
    expect(t.claim).not.toHaveBeenCalled();
    expect(t.writes).toHaveLength(0);
  });

  it('flags mail from the other principal address', async () => {
    const t = setup({
      'grant-work': [],
      'grant-personal': [msg('fwd', NOW_S - 1, { from: [{ email: WORK_ADDR }] })],
    }, { headers: { fwd: [{ name: 'Message-ID', value: '<fwd@mail.example.org>' }] } });
    const d = dataOf(await t.run());
    expect(d.messages).toHaveLength(1);
    expect(d.messages[0]!.from_principal_other_mailbox).toBe(true);
  });

  it('keeps a losing copy whose mark-read fails, so older mail still flows', async () => {
    const t = setup({
      'grant-work': [],
      'grant-personal': [msg('copy', NOW_S - 1, { to: [{ email: WORK_ADDR }] }), msg('older', NOW_S - 2)],
    }, {
      headers: { copy: [{ name: 'Message-ID', value: '<abc@mail.example.org>' }] },
      claim: async () => ({ first: false, mailboxId: 'work', nylasMessageId: 'w-copy' }),
      failWrite: (method, path) => method === 'PUT' && path === '/messages/copy',
    });
    const first = dataOf(await t.run());
    expect(first.messages.map((m) => m.id)).toEqual(['copy', 'older']);
    expect(t.writes.some((w) => w.path === '/folders' && w.method === 'POST')).toBe(false);
    // The failure repeats on the next call without ever blocking the older message.
    vi.setSystemTime(new Date(NOW.getTime() + 20 * 60_000));
    expect(dataOf(await t.run()).messages.map((m) => m.id)).toEqual(['copy', 'older']);
  });

  it('looks the label folder up once per call', async () => {
    const t = setup({
      'grant-work': [],
      'grant-personal': [
        msg('c1', NOW_S - 1, { to: [{ email: WORK_ADDR }] }),
        msg('c2', NOW_S - 2, { to: [{ email: WORK_ADDR }] }),
      ],
    }, {
      headers: { c1: [{ name: 'Message-ID', value: '<1@mail.example.org>' }], c2: [{ name: 'Message-ID', value: '<2@mail.example.org>' }] },
      claim: async () => ({ first: false, mailboxId: 'work', nylasMessageId: 'w' }),
    });
    expect(dataOf(await t.run()).count).toBe(0);
    expect(t.writes.filter((w) => w.path === '/folders')).toHaveLength(2); // one list, one create
  });

  it('uses the principal timezone from the triage services for windows', async () => {
    // 15:00Z is 10:00 in Toronto: inside 09:00-11:00 there, outside it in UTC.
    const mk = (tz: string) => setup({ 'grant-work': [msg('w1', NOW_S - 1)], 'grant-personal': [] }, { cadence: 'every 15m 09:00-11:00', tz });
    expect(dataOf(await mk('America/Toronto').run()).messages.map((m) => m.id)).toEqual(['w1']);
    expect(dataOf(await mk('UTC').run()).mailboxes_due).toEqual([]);
  });

  it('refuses triage outside an inbox-drain task turn', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)] });
    expect((await t.run({ triage: true }, { taskMetadata: {} })).success).toBe(false);
    expect((await t.run({ triage: true }, { taskMetadata: { originator: { systemRole: 'system' } } })).success).toBe(false);
    expect((await t.run({ triage: true }, { taskMetadata: { originator: { systemRole: 'system' }, boundTask: { tags: ['other'] } } })).success).toBe(false);
    expect((await t.run({ triage: true }, principalTurn)).success).toBe(false);
    expect(t.requests).toHaveLength(0);
    expect((await t.run({ triage: true })).success).toBe(true);
  });

  it('needs system lineage as well as the inbox-drain tag (P6, R55)', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)] });
    const tagged = (originator: Record<string, unknown>) => ({ taskMetadata: { originator, boundTask: { taskId: 't1', tags: ['inbox-drain'] } } });
    expect((await t.run({ triage: true }, tagged({ systemRole: 'principal', channel: 'signal' }))).success).toBe(false);
    expect((await t.run({ triage: true }, tagged({ systemRole: null, contactId: 'c-1', tier: 'outsider' }))).success).toBe(false);
    expect(t.requests).toHaveLength(0);
    // Raw system lineage on a task tagged inbox-drain: the heartbeat's own drain.
    expect((await t.run({ triage: true }, tagged({ systemRole: 'system' }))).success).toBe(true);
  });

  it('accepts a laddered system lineage and refuses other laddered agents', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)] });
    const agentTurn = (ladderedFrom: string | null) => ({ taskMetadata: { originator: { systemRole: 'agent', ladderedFrom }, boundTask: { tags: ['inbox-drain'] } } });
    expect((await t.run({ triage: true }, agentTurn('principal'))).success).toBe(false);
    expect((await t.run({ triage: true }, agentTurn(null))).success).toBe(false);
    expect((await t.run({ triage: true }, agentTurn('system'))).success).toBe(true);
  });

  it('runs an inbox-drain turn\'s plain unread listing in triage mode (R66)', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)], 'grant-personal': [] });
    const d = dataOf(await t.run({ unread_only: true, limit: 5 }));
    expect(d.mailboxes_due).toEqual(['work', 'personal']);
    expect(d.messages.map((m) => m.id)).toEqual(['w1']);
    expect(t.data.get('triage.batches.2026-11-12')).toBe('1');
  });

  it('keeps the ordinary listing for an explicit departure on a drain turn, and off drain turns (R66)', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)], 'grant-personal': [] });
    for (const input of [{ folder: 'SENT' }, { unread_only: false }, { mailbox: 'work' }]) {
      const r = await t.run(input);
      expect(r.success && (r.data as Record<string, unknown>)['mailboxes_due']).toBeFalsy();
    }
    const offDrain = await t.run({ unread_only: true, limit: 5 }, { taskMetadata: { originator: { systemRole: 'system' } } });
    expect(offDrain.success && (offDrain.data as Record<string, unknown>)['mailboxes_due']).toBeFalsy();
    expect(t.data.get('triage.batches.2026-11-12')).toBeUndefined();
  });

  it('ignores a mailbox input in triage mode', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)], 'grant-personal': [msg('p1', NOW_S - 2)] });
    const d = dataOf(await t.run({ triage: true, mailbox: 'work' }));
    expect(d.messages.map((m) => m.id)).toEqual(['w1', 'p1']);
  });

  it('leaves the drain state alone when the page cap stops a scan that kept nothing', async () => {
    const junk = Array.from({ length: 40 }, (_, i) => msg(`j${i}`, NOW_S - i, { from: [{ email: 'curia@example.com' }] }));
    const t = setup({ 'grant-work': junk, 'grant-personal': [] }, { pageSize: 1, ctxExtra: { selfEmails: ['curia@example.com'] } });
    const r = await t.run();
    const d = r.success ? (r.data as TriageData & { scan_incomplete?: boolean }) : undefined;
    expect(d?.scan_incomplete).toBe(true);
    expect(d?.count).toBe(0);
    expect(await t.state.lastDrainedAt('work')).toBeNull();
  });

  it('names the reason when the only due mailbox fails', async () => {
    const t = setup({ 'grant-work': [msg('w1', NOW_S - 1)] }, { failList: true });
    const r = await t.run({ triage: true }, { principalMailboxes: stubPrincipalMailboxes({ mailboxes: [mailboxView('work', 'Work', WORK_ADDR, true)], grantId: 'grant-work' }) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('HTTP 500');
  });

  it('counts a batch only when it returns messages', async () => {
    const empty = setup({ 'grant-work': [], 'grant-personal': [] });
    expect(dataOf(await empty.run()).count).toBe(0);
    expect(empty.data.get('triage.batches.2026-11-12')).toBeUndefined();
    const busy = setup({ 'grant-work': [msg('w1', NOW_S - 1)], 'grant-personal': [] });
    dataOf(await busy.run());
    expect(busy.data.get('triage.batches.2026-11-12')).toBe('1');
  });

  it('stamps a drain with its start so every 15m is due at the next tick (R52)', async () => {
    const work = Array.from({ length: 16 }, (_, i) => msg(`w${i}`, NOW_S - i));
    const t = setup({ 'grant-work': work, 'grant-personal': [] });
    const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
    for (const minute of [0, 7, 14, 20]) {
      vi.setSystemTime(at(minute));
      const d = dataOf(await t.run());
      // The agent marks the batch read, so those messages leave the unread set.
      for (const m of d.messages) work.splice(work.findIndex((w) => w['id'] === m.id), 1);
    }
    expect(work).toHaveLength(0);
    expect(await t.state.isDraining('work')).toBe(false);
    expect(await t.state.lastDrainedAt('work')).toEqual(NOW); // the start, not minute 20
    expect(await t.state.drainStartedAt('work')).toBeNull();
    const due = await dueMailboxes({
      mailboxIds: ['work'], cadences: { work: parseCadence('every 15m')! }, state: t.state, now: at(30), tz: 'UTC',
    });
    expect(due).toEqual(['work']);
  });
});
