import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxListHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { Logger } from '../../../../src/logger.js';

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
    secret(name: string) {
      if (name === 'channel.email.nylas_api_key') return 'test-key';
      if (name === 'ceo_nylas_grant_id') return 'test-grant';
      throw new Error(`unknown secret: ${name}`);
    },
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
    const fetchSpy = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ data: curiaPage, next_cursor: 'again' }),
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
