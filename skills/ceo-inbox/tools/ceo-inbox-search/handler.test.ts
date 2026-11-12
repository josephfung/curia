import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxSearchHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { Logger } from '../../../../src/logger.js';
import { pagedMessagesFetch, rawMessage, stubPrincipalMailboxes, twoMailboxes } from '../../../_shared/principal-mailboxes-test-helpers.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(
  input: Record<string, unknown>,
  opts: { selfEmail?: string; liveSelfEmails?: string[] } = {},
): ToolContext {
  return {
    toolName: 'ceo-inbox-search',
    toolVersion: '0.2.0',
    input,
    // Curia's own addresses come from its email accounts, not a vault key (#2409).
    selfEmails: opts.selfEmail ? [opts.selfEmail] : [],
    ...(opts.liveSelfEmails ? { curiaEmailAddresses: async () => opts.liveSelfEmails! } : {}),
    // The handlers read credentials from principalMailboxes, never from secrets.
    secret: (key: string): string => { throw new Error(`unexpected secret read: ${key}`); },
    principalMailboxes: stubPrincipalMailboxes({ grantId: 'test-grant', apiKey: 'test-key' }),
    // The mock only implements the logger methods these tests exercise; cast to
    // the real Logger type through unknown since the shape is intentionally partial.
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  };
}

function mockFetchReturning(messages: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: messages }),
  } as unknown as Response);
}

function extractQueryParam(fetchMock: ReturnType<typeof vi.fn>, param: string): string | null {
  const url = new URL(fetchMock.mock.calls[0]![0] as string);
  return url.searchParams.get(param);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CeoInboxSearchHandler — query parameter', () => {
  let handler: CeoInboxSearchHandler;

  beforeEach(() => {
    handler = new CeoInboxSearchHandler();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses search_query_native instead of q', async () => {
    const ctx = makeCtx({ query: 'Tim Hortons receipt' });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    // Nylas v3 requires search_query_native — the old q parameter is rejected with HTTP 400
    expect(extractQueryParam(fetchSpy, 'search_query_native')).toBe('Tim Hortons receipt');
    expect(extractQueryParam(fetchSpy, 'q')).toBeNull();
  });

  it('does not send other filter params when search_query_native is set', async () => {
    // Nylas v3 rejects any param other than limit/page_token alongside search_query_native
    const ctx = makeCtx({ query: 'expense report' });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    expect(extractQueryParam(fetchSpy, 'unread')).toBeNull();
    expect(extractQueryParam(fetchSpy, 'in')).toBeNull();
    expect(extractQueryParam(fetchSpy, 'received_after')).toBeNull();
  });

  it('returns error when query is missing', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
  });

  it('returns error when query is empty string', async () => {
    const ctx = makeCtx({ query: '   ' });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
  });

  it('respects the limit parameter', async () => {
    const ctx = makeCtx({ query: 'invoice', limit: 5 });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    expect(extractQueryParam(fetchSpy, 'limit')).toBe('5');
  });

  function message(partial: { id: string; folders: string[]; from?: string }): Record<string, unknown> {
    return {
      id: partial.id,
      thread_id: `t-${partial.id}`,
      subject: '',
      snippet: '',
      date: 0,
      unread: true,
      from: [{ email: partial.from ?? 'someone@example.com', name: 'Someone' }],
      folders: partial.folders,
    };
  }

  it('omits Spam and Trash from is:unread unless the caller opts in (#2035)', async () => {
    const rows = [
      message({ id: 'pitch', folders: ['SPAM'] }),
      message({ id: 'gone', folders: ['TRASH'] }),
      message({ id: 'mixed', folders: ['INBOX', 'spam'] }),
      message({ id: 'real', folders: ['INBOX'] }),
    ];

    // Two cron-style runs. The spam pitch never surfaces, so triage has nothing to draft.
    for (let run = 0; run < 2; run++) {
      const fetchSpy = mockFetchReturning(rows);
      vi.stubGlobal('fetch', fetchSpy);
      const result = await handler.execute(makeCtx({ query: 'is:unread' }));
      expect(result.success).toBe(true);
      if (!result.success) return;
      const data = result.data as { messages: Array<{ id: string }>; count: number };
      expect(data.messages.map((m) => m.id)).toEqual(['real']);
      expect(data.count).toBe(1);
      vi.unstubAllGlobals();
    }

    const opted = mockFetchReturning(rows);
    vi.stubGlobal('fetch', opted);
    const optedResult = await handler.execute(makeCtx({
      query: 'is:unread',
      include_spam_and_trash: true,
    }));
    expect(optedResult.success).toBe(true);
    if (!optedResult.success) return;
    const optedData = optedResult.data as { messages: Array<{ id: string }> };
    expect(optedData.messages.map((m) => m.id)).toEqual(['pitch', 'gone', 'mixed', 'real']);
  });

  it('pages past a Spam-only result to the next inbox message (#2035)', async () => {
    const spamPage = Array.from({ length: 10 }, (_, i) => message({ id: `spam-${i}`, folders: ['SPAM'] }));
    const inbox = message({ id: 'real', folders: ['INBOX'] });
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page_token');
      if (!page) {
        return { ok: true, json: async () => ({ data: spamPage, next_cursor: 'p2' }) };
      }
      return { ok: true, json: async () => ({ data: [inbox] }) };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(makeCtx({ query: 'is:unread', limit: 10 }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { messages: Array<{ id: string }>; count: number };
    expect(data.messages.map((m) => m.id)).toEqual(['real']);
    expect(data.count).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const second = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(second.searchParams.get('page_token')).toBe('p2');
    expect(second.searchParams.get('search_query_native')).toBeNull();
  });

  it('filters out messages from the Curia self email', async () => {
    const curiaEmail = 'curia@example.com';
    const ctx = makeCtx({ query: 'test' }, { selfEmail: curiaEmail });
    const fetchSpy = mockFetchReturning([
      { id: '1', from: [{ email: curiaEmail, name: 'Curia' }], thread_id: '1', subject: '', snippet: '', date: 0, unread: false, folders: [] },
      { id: '2', from: [{ email: 'someone@example.com', name: 'Someone' }], thread_id: '2', subject: '', snippet: '', date: 0, unread: false, folders: [] },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { messages: unknown[]; count: number };
      expect(data.count).toBe(1);
      expect(data.messages).toHaveLength(1);
    }
  });

  it('filters a Curia mailbox added in the console since boot (#2409)', async () => {
    const added = 'sched@example.com';
    const ctx = makeCtx({ query: 'test' }, { liveSelfEmails: [added] });
    vi.stubGlobal('fetch', mockFetchReturning([
      { id: '1', from: [{ email: added, name: 'Curia' }], thread_id: '1', subject: '', snippet: '', date: 0, unread: false, folders: [] },
      { id: '2', from: [{ email: 'someone@example.com', name: 'Someone' }], thread_id: '2', subject: '', snippet: '', date: 0, unread: false, folders: [] },
    ]));

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { messages: Array<{ id: string }>; count: number };
    expect(data.count).toBe(1);
    expect(data.messages.map((m) => m.id)).toEqual(['2']);
  });
});

describe('CeoInboxSearchHandler — drafts search (#1000)', () => {
  let handler: CeoInboxSearchHandler;

  const DRAFTS = [
    { id: 'd1', thread_id: 't1', subject: 'Quarterly report', to: [{ email: 'alice@example.com', name: 'Alice' }], cc: [], snippet: '', date: 1 },
    { id: 'd2', thread_id: 't2', subject: 'Lunch plans', to: [{ email: 'bob@example.com', name: 'Bob' }], cc: [], snippet: '', date: 2 },
  ];

  beforeEach(() => {
    handler = new CeoInboxSearchHandler();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes to the /drafts resource when folder is DRAFTS', async () => {
    const ctx = makeCtx({ query: 'report', folder: 'DRAFTS' });
    const fetchSpy = mockFetchReturning(DRAFTS);
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.pathname.endsWith('/drafts')).toBe(true);
    expect(url.pathname).not.toContain('/messages');
  });

  it('does not send search_query_native to the drafts endpoint (filters client-side)', async () => {
    const ctx = makeCtx({ query: 'report', folder: 'DRAFTS' });
    const fetchSpy = mockFetchReturning(DRAFTS);
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    expect(extractQueryParam(fetchSpy, 'search_query_native')).toBeNull();
  });

  it('filters drafts by subject substring (case-insensitive)', async () => {
    const ctx = makeCtx({ query: 'quarterly', folder: 'DRAFTS' });
    const fetchSpy = mockFetchReturning(DRAFTS);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { data: { drafts: Array<{ id: string }>; count: number } }).data;
    expect(data.count).toBe(1);
    expect(data.drafts[0]!.id).toBe('d1');
  });

  it('filters drafts by recipient email address', async () => {
    const ctx = makeCtx({ query: 'bob@example.com', folder: 'DRAFTS' });
    const fetchSpy = mockFetchReturning(DRAFTS);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);

    const data = (result as { data: { drafts: Array<{ id: string }>; count: number } }).data;
    expect(data.count).toBe(1);
    expect(data.drafts[0]!.id).toBe('d2');
  });

  it('filters drafts by recipient name', async () => {
    const ctx = makeCtx({ query: 'Alice', folder: 'DRAFTS' });
    const fetchSpy = mockFetchReturning(DRAFTS);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);

    const data = (result as { data: { drafts: Array<{ id: string }>; count: number } }).data;
    expect(data.count).toBe(1);
    expect(data.drafts[0]!.id).toBe('d1');
  });

  it('paginates across draft pages and finds a match beyond the first page', async () => {
    // Page 1 (100 drafts, none matching) + a cursor, then page 2 with the match.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `p1-${i}`, thread_id: `t${i}`, subject: 'noise', to: [], cc: [], snippet: '', date: i,
    }));
    const page2 = [{ id: 'match', thread_id: 'tm', subject: 'the quarterly report', to: [], cc: [], snippet: '', date: 999 }];
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: page1, next_cursor: 'CUR2' }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: page2 }) } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const ctx = makeCtx({ query: 'quarterly', folder: 'DRAFTS' });
    const result = await handler.execute(ctx);

    const data = (result as { data: { drafts: Array<{ id: string }>; count: number } }).data;
    expect(data.count).toBe(1);
    expect(data.drafts[0]!.id).toBe('match');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('warns (does not silently truncate) when more drafts exist than the scan cap', async () => {
    // Every page is full and always returns a cursor, so the DRAFT_SCAN_LIMIT
    // ceiling is hit with more pages still available → truncated → warn.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `d${i}`, thread_id: `t${i}`, subject: 'report', to: [], cc: [], snippet: '', date: i,
    }));
    const fetchSpy = vi
      .fn()
      .mockImplementation(async () => ({ ok: true, json: async () => ({ data: fullPage, next_cursor: 'MORE' }) } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);

    const ctx = makeCtx({ query: 'report', folder: 'DRAFTS' });
    await handler.execute(ctx);

    const warnCalls = (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c: unknown[]) => typeof c[1] === 'string' && c[1].includes('cap'))).toBe(true);
  });
});

describe('CeoInboxSearchHandler — drafts date filter and authorship (#2474)', () => {
  const handler = new CeoInboxSearchHandler();
  // 2026-11-07T13:00:00Z = 08:00 in Toronto; d1 is before, d2 and d3 at/after.
  const RAW = [
    { id: 'd1', thread_id: 't1', subject: 'x old', to: [], cc: [], snippet: '', date: 1794056400 - 3600 },
    { id: 'd2', thread_id: 't2', subject: 'x edge', to: [], cc: [], snippet: '', date: 1794056400 },
    { id: 'd3', thread_id: 't3', subject: 'x new', to: [], cc: [], snippet: '', date: 1794056400 + 3600 },
  ];
  const SINCE = '2026-11-07T08:00:00-05:00';
  const repo = (rows: unknown[] | Error) => ({
    findToolResults: rows instanceof Error ? vi.fn().mockRejectedValue(rows) : vi.fn().mockResolvedValue(rows),
    findToolResultsForTasks: vi.fn(),
  });
  const ctxWith = (input: Record<string, unknown>, auditLogRepo: unknown) =>
    ({ ...makeCtx({ ...input, query: 'x' }), timezone: 'America/Toronto', auditLogRepo }) as unknown as ToolContext;

  afterEach(() => { vi.unstubAllGlobals(); });

  it('filters drafts by modified_since', async () => {
    vi.stubGlobal('fetch', mockFetchReturning(RAW));
    const result = await handler.execute(ctxWith({ folder: 'DRAFTS', modified_since: SINCE }, repo([])));
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Array<{ id: string }>; count: number };
    expect(data.drafts.map((d) => d.id)).toEqual(['d2', 'd3']);
    expect(data.count).toBe(2);
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

describe('CeoInboxSearchHandler — every mailbox (#2475)', () => {
  afterEach(() => vi.restoreAllMocks());

  const ctxFor = (input: Record<string, unknown>): ToolContext =>
    ({ ...makeCtx(input), principalMailboxes: twoMailboxes() }) as ToolContext;
  type Item = { id: string; mailbox: string; mailbox_label: string };
  type Data = { messages: Item[]; count: number; next_page_token?: string; mailbox_errors?: Array<{ mailbox: string; mailbox_label: string; error: string }> };

  function serve(byGrant: Record<string, Array<Record<string, unknown>>>, opts: Parameters<typeof pagedMessagesFetch>[1] = {}) {
    const f = pagedMessagesFetch(byGrant, opts);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => f.fetchStub(url));
    return f;
  }
  const run = (input: Record<string, unknown>) => new CeoInboxSearchHandler().execute(ctxFor({ query: 'invoice', ...input }));

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
    expect(data.next_page_token).toBeUndefined();
  });

  it('a failing mailbox is reported and does not hide the other', async () => {
    serve({ 'grant-work': [rawMessage('w1', 100)] }, { failing: ['grant-personal'] });
    const result = await run({ limit: 10 });
    if (!result.success) throw new Error(result.error);
    const data = result.data as Data;
    expect(data.messages.map((m) => m.id)).toEqual(['w1']);
    expect(data.mailbox_errors).toEqual([{ mailbox: 'personal', mailbox_label: 'Personal', error: 'HTTP 500' }]);
    expect(JSON.stringify(result)).not.toContain('grant-');
  });

  it('fails when every mailbox fails', async () => {
    serve({}, { failing: ['grant-work', 'grant-personal'] });
    expect((await run({ limit: 10 })).success).toBe(false);
  });

  it('explicit mailbox reads only that mailbox', async () => {
    const f = serve({ 'grant-work': [rawMessage('w1', 100)], 'grant-personal': [rawMessage('p1', 98)] });
    const result = await run({ mailbox: 'work' });
    if (!result.success) throw new Error(result.error);
    expect((result.data as Data).messages.map((m) => m.id)).toEqual(['w1']);
    expect(f.requests.every((r) => r.grant === 'grant-work')).toBe(true);
  });

  it('DRAFTS searches drafts in every mailbox, labelled', async () => {
    const draft = (id: string, date: number) => ({ id, thread_id: `t${id}`, subject: 'invoice', to: [], cc: [], snippet: '', date });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const grant = /\/grants\/([^/]+)/.exec(new URL(String(url)).pathname)![1]!;
      const data = grant === 'grant-work' ? [draft('dw', 10)] : [draft('dp', 20)];
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const result = await run({ folder: 'DRAFTS' });
    if (!result.success) throw new Error(result.error);
    const data = result.data as { drafts: Item[] };
    expect(data.drafts.map((d) => [d.id, d.mailbox])).toEqual([['dp', 'personal'], ['dw', 'work']]);
  });

  it('pages through two mailboxes to the end and returns every message exactly once', async () => {
    const work = Array.from({ length: 7 }, (_, i) => rawMessage(`w${i}`, 200 - i * 7));
    const personal = Array.from({ length: 6 }, (_, i) => rawMessage(`p${i}`, 203 - i * 5));
    const f = serve({ 'grant-work': work, 'grant-personal': personal }, { pageSize: 3 });

    const seen: string[] = [];
    let token: string | undefined;
    for (let call = 0; call < 20; call++) {
      const result = await run({ limit: 4, ...(token ? { page_token: token } : {}) });
      if (!result.success) throw new Error(result.error);
      const data = result.data as Data;
      seen.push(...data.messages.map((m) => m.id));
      token = data.next_page_token;
      if (!token) break;
    }
    expect(token).toBeUndefined();
    expect([...seen].sort()).toEqual([...work, ...personal].map((m) => m.id as string).sort());
    expect(new Set(seen).size).toBe(seen.length);
    // A search follow-up stays token-only: re-sending filters beside a search query is rejected.
    for (const r of f.requests.filter((x) => x.params.get('page_token'))) {
      expect(r.params.get('search_query_native')).toBeNull();
    }
  });

  it('refuses a page_token it cannot decode and says to retry without it', async () => {
    const f = serve({});
    const result = await run({ page_token: 'raw-cursor' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('without page_token');
    expect(f.requests).toHaveLength(0);
  });
});
