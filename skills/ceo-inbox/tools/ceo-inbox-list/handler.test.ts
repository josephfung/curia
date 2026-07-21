import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CeoInboxListHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { Logger } from '../../../../src/logger.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal ToolContext. The Nylas client is mocked at the fetch level
 *  so we can inspect the outgoing query params. There is no watermark anymore,
 *  so no entityMemory wiring is needed. */
function makeCtx(
  input: Record<string, unknown>,
  opts: { selfEmail?: string } = {},
): ToolContext {
  return {
    input,
    secret(name: string) {
      if (name === 'nylas_api_key') return 'test-key';
      if (name === 'ceo_nylas_grant_id') return 'test-grant';
      if (name === 'nylas_self_email') {
        if (opts.selfEmail) return opts.selfEmail;
        throw new Error('not set');
      }
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

  it('keeps has_more=true (probe-based) even when a Curia-self message is in a full window', async () => {
    // limit 5 → fetch 6. One of the 6 is Curia-self (filtered out), but the raw
    // probe still had > limit results, so real backlog must not be under-reported.
    const self = 'curia@example.com';
    const ctx = makeCtx({ unread_only: true, limit: 5 }, { selfEmail: self });
    const real = unreadMessages(5) as Array<{ from: Array<{ email: string; name: string }> }>;
    const curia = { id: 'mc', threadId: 'tc', date: 99, subject: 'self', from: [{ email: self, name: 'Curia' }], to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [] };
    const fetchSpy = mockFetchReturning([curia, ...real]); // 6 raw, 1 filtered
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);
    if (!result.success) throw new Error(result.error);
    const data = result.data as { count: number; has_more: boolean };
    expect(data.count).toBe(5); // 5 real returned
    expect(data.has_more).toBe(true); // raw.length (6) > limit (5)
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
