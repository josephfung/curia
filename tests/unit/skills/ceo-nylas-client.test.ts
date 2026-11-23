import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { htmlToPlainText } from '../../../skills/_shared/ceo-nylas-client.js';

// We can't easily mock global fetch per-test with vi.fn(), so instead we
// test the CeoNylasClient by spying on global.fetch and inspecting the URL
// it receives — that's where the folder alias normalization is observable.

const logger = pino({ level: 'silent' });

// Dynamically import after setting up the fetch mock so the module-level
// constant (`NYLAS_BASE`) picks up correctly.
let CeoNylasClient: typeof import('../../../skills/_shared/ceo-nylas-client.js').CeoNylasClient;
let NylasApiError: typeof import('../../../skills/_shared/ceo-nylas-client.js').NylasApiError;

beforeEach(async () => {
  vi.restoreAllMocks();
  const mod = await import('../../../skills/_shared/ceo-nylas-client.js');
  CeoNylasClient = mod.CeoNylasClient;
  NylasApiError = mod.NylasApiError;
  // listFolders results are cached per grant; each test starts cold.
  mod.clearFolderCache();
});

function mockFetchSuccess(data: unknown = []) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('htmlToPlainText', () => {
  it('returns empty string for null or undefined input', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText(undefined)).toBe('');
  });

  it('strips basic HTML tags', () => {
    expect(htmlToPlainText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('converts <br> to newlines', () => {
    expect(htmlToPlainText('Line 1<br>Line 2')).toContain('Line 1\nLine 2');
  });

  it('strips <script> blocks including their content', () => {
    const html = 'before <script>alert(1)</script> after';
    const result = htmlToPlainText(html);
    expect(result).toContain('before');
    expect(result).toContain('after');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('<script');
  });

  it('strips <style> blocks including their content', () => {
    const html = '<style>.x { color: red; }</style><p>Content</p>';
    const result = htmlToPlainText(html);
    expect(result).toContain('Content');
    expect(result).not.toContain('color');
    expect(result).not.toContain('<style');
  });

  it('strips <script> blocks whose closing tag has trailing whitespace (</script >)', () => {
    const html = 'before <script>evil()</script > after';
    const result = htmlToPlainText(html);
    expect(result).not.toContain('evil');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('handles nested-substitution bypass attempt (<scri<script>pt>)', () => {
    // A crafted input that tries to smuggle <script> through the strip:
    // stripping the inner <script>...</script> block leaves outer fragments
    // that merge into a new <script> tag. The stability loop catches this.
    const html = '<scri<script>alert(1)</script>pt>payload</script>';
    const result = htmlToPlainText(html);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
  });

  it('decodes HTML entities', () => {
    expect(htmlToPlainText('&amp; &lt; &gt;')).toBe('& < >');
  });
});

describe('CeoNylasClient request envelope handling', () => {
  it('throws a NylasApiError when a successful response has no data envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ request_id: 'req-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new CeoNylasClient('key', 'grant', logger);
    const request = client.listFolders();

    await expect(request).rejects.toMatchObject({
      name: 'NylasApiError',
      status: 200,
      endpoint: 'listFolders',
      message: 'Nylas listFolders: response missing data envelope',
    });
    await expect(request).rejects.toBeInstanceOf(NylasApiError);
  });

  it('throws a NylasApiError when a successful response body is null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new CeoNylasClient('key', 'grant', logger);
    const request = client.listFolders();

    await expect(request).rejects.toMatchObject({
      name: 'NylasApiError',
      status: 200,
      endpoint: 'listFolders',
      message: 'Nylas listFolders: response missing data envelope',
    });
    await expect(request).rejects.toBeInstanceOf(NylasApiError);
  });
});

describe('CeoNylasClient.listMessages — folder alias normalization', () => {
  it('normalizes DRAFTS to DRAFT for Gmail compatibility', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'DRAFTS' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('DRAFT');
  });

  it('passes INBOX unchanged (no alias needed)', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'INBOX' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('INBOX');
  });

  it('passes DRAFT unchanged (already correct)', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'DRAFT' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('DRAFT');
  });

  it('re-sends in/unread/received_* with page_token on a follow-up page (#2377)', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);

    await client.listMessagesPage({
      pageToken: 'CUR',
      folder: 'INBOX',
      unread: true,
      receivedAfter: 100,
      receivedBefore: 200,
      limit: 20,
    });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('page_token')).toBe('CUR');
    expect(url.searchParams.get('in')).toBe('INBOX');
    expect(url.searchParams.get('unread')).toBe('true');
    expect(url.searchParams.get('received_after')).toBe('100');
    expect(url.searchParams.get('received_before')).toBe('200');
  });

  it('listAllMessages re-sends the filters on every page (#2377)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'a' }], next_cursor: 'CUR2' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'b' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    const client = new CeoNylasClient('key', 'grant', logger);

    const { messages } = await client.listAllMessages({ folder: 'SENT', receivedAfter: 100 });

    expect(messages.map((m) => m.id)).toEqual(['a', 'b']);
    const second = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(second.searchParams.get('page_token')).toBe('CUR2');
    expect(second.searchParams.get('in')).toBe('SENT');
    expect(second.searchParams.get('received_after')).toBe('100');
  });

  describe('listAllMessages paced listing (#2362)', () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    // Page-delay sleeps are the 1000/2000 ms timers; a 429 retry backoff is ~375-625 ms.
    function spyDelays(): number[] {
      const delays: number[] = [];
      const real = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
        if (typeof ms === 'number') delays.push(ms);
        return real(fn, ms, ...rest);
      }) as typeof setTimeout);
      return delays;
    }

    it('sleeps pageDelayMs between pages', async () => {
      vi.useFakeTimers();
      try {
        const delays = spyDelays();
        vi.spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
          .mockResolvedValueOnce(json({ data: [{ id: 'b' }], next_cursor: 'C3' }))
          .mockResolvedValueOnce(json({ data: [{ id: 'c' }] }));
        const client = new CeoNylasClient('key', 'grant', logger);

        const pending = client.listAllMessages({ pageDelayMs: 1000 });
        await vi.runAllTimersAsync();
        const { messages } = await pending;

        expect(messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
        expect(delays.filter((d) => d >= 1000)).toEqual([1000, 1000]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('doubles the page delay after a 429 and reports it via onPage', async () => {
      vi.useFakeTimers();
      try {
        const delays = spyDelays();
        vi.spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
          .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
          .mockResolvedValueOnce(json({ data: [{ id: 'b' }], next_cursor: 'C3' }))
          .mockResolvedValueOnce(json({ data: [{ id: 'c' }] }));
        const client = new CeoNylasClient('key', 'grant', logger);
        const pages: Array<{ requests: number; rateLimited: boolean }> = [];

        const pending = client.listAllMessages({ pageDelayMs: 1000, onPage: (p) => { pages.push(p); } });
        await vi.runAllTimersAsync();
        await pending;

        expect(delays.filter((d) => d >= 1000)).toEqual([1000, 2000]);
        expect(pages).toEqual([
          { requests: 1, rateLimited: false },
          { requests: 2, rateLimited: true },
          { requests: 1, rateLimited: false },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('existing callers see no delay', async () => {
      const delays = spyDelays();
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
        .mockResolvedValueOnce(json({ data: [{ id: 'b' }] }));
      const client = new CeoNylasClient('key', 'grant', logger);

      await client.listAllMessages({});

      expect(delays).toEqual([]);
    });

    it('stops paging when onPage returns false, keeping what was read', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
        .mockResolvedValueOnce(json({ data: [{ id: 'b' }], next_cursor: 'C3' }))
        .mockResolvedValueOnce(json({ data: [{ id: 'c' }] }));
      const client = new CeoNylasClient('key', 'grant', logger);
      let pages = 0;

      const { messages, truncated } = await client.listAllMessages({ onPage: () => ++pages < 2 });

      expect(messages.map((m) => m.id)).toEqual(['a', 'b']);
      expect(truncated).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    describe('a late transient failure with onPage keeps the pages already read', () => {
      it.each([
        ['a 429 that outlasts its retries', () => new Response('slow down', { status: 429 }), 'rate_limited'],
        ['a 5xx that outlasts its retries', () => new Response('bad gateway', { status: 502 }), 'server_error'],
      ] as const)('%s', async (_name, failing, endedOn) => {
        vi.useFakeTimers();
        try {
          vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
            .mockImplementation(async () => failing());
          const client = new CeoNylasClient('key', 'grant', logger);
          const pages: Array<{ requests: number; rateLimited: boolean }> = [];

          const pending = client.listAllMessages({ onPage: (p) => { pages.push(p); } });
          await vi.runAllTimersAsync();
          const result = await pending;

          expect(result.messages.map((m) => m.id)).toEqual(['a']);
          expect(result).toMatchObject({ truncated: true, endedOn });
          // The failed page is reported too, retries included.
          expect(pages).toHaveLength(2);
          expect(pages[1]!.requests).toBeGreaterThan(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('a failed fetch (status 0)', async () => {
        vi.spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
          .mockRejectedValueOnce(new TypeError('fetch failed'));
        const client = new CeoNylasClient('key', 'grant', logger);

        const result = await client.listAllMessages({ onPage: () => true });

        expect(result.messages.map((m) => m.id)).toEqual(['a']);
        expect(result).toMatchObject({ truncated: true, endedOn: 'network' });
      });

      it('still throws when the first page fails', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
        const client = new CeoNylasClient('key', 'grant', logger);
        await expect(client.listAllMessages({ onPage: () => true })).rejects.toMatchObject({ status: 0 });
      });

      it('still throws on a non-transient error', async () => {
        vi.spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
          .mockResolvedValueOnce(new Response('nope', { status: 401 }));
        const client = new CeoNylasClient('key', 'grant', logger);
        await expect(client.listAllMessages({ onPage: () => true })).rejects.toMatchObject({ status: 401 });
      });

      it('callers without onPage keep the throw', async () => {
        vi.spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
          .mockRejectedValueOnce(new TypeError('fetch failed'));
        const client = new CeoNylasClient('key', 'grant', logger);
        await expect(client.listAllMessages({})).rejects.toMatchObject({ status: 0 });
      });
    });

    it('refuses a page delay that outlasts the call budget', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json({ data: [{ id: 'a' }], next_cursor: 'C2' }))
        .mockResolvedValueOnce(json({ data: [{ id: 'b' }] }));
      const budget = { deadline: Date.now() + 500, signal: new AbortController().signal };
      const client = new CeoNylasClient('key', 'grant', logger, budget);

      await expect(client.listAllMessages({ pageDelayMs: 1000 })).rejects.toBeInstanceOf(NylasApiError);
    });
  });

  it('sends only page_token on a search_query_native follow-up page', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [], next_cursor: 'CUR' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new CeoNylasClient('key', 'grant', logger);

    const page = await client.listMessagesPage({
      pageToken: 'CUR',
      folder: 'INBOX',
      unread: true,
      query: 'is:unread',
      limit: 5,
    });

    expect(page.nextCursor).toBe('CUR');
    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('page_token')).toBe('CUR');
    expect(url.searchParams.get('in')).toBeNull();
    expect(url.searchParams.get('unread')).toBeNull();
    expect(url.searchParams.get('search_query_native')).toBeNull();
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('passes custom label names through unmodified', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'Label_42' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('Label_42');
  });
});

describe('CeoNylasClient — drafts (issue #1000)', () => {
  const RAW_DRAFT_SUMMARY = {
    id: 'draft-1',
    thread_id: 'thread-1',
    subject: 'Quarterly update',
    to: [{ name: 'Alice', email: 'alice@example.com' }],
    cc: [{ email: 'bob@example.com' }],
    snippet: 'Hi Alice, here is the update',
    date: 1_700_000_000,
  };

  describe('listDrafts', () => {
    it('hits the /drafts collection — NOT /messages', async () => {
      const fetchSpy = mockFetchSuccess([RAW_DRAFT_SUMMARY]);
      const client = new CeoNylasClient('key', 'grant', logger);
      // limit: 25 exceeds the Nylas cap (20) and is silently clamped.
      await client.listDrafts({ limit: 25 });

      const url = new URL(fetchSpy.mock.calls[0]![0] as string);
      expect(url.pathname.endsWith('/drafts')).toBe(true);
      expect(url.pathname).not.toContain('/messages');
      expect(url.searchParams.get('limit')).toBe('20');
    });

    it('never sends a received_after / watermark param', async () => {
      const fetchSpy = mockFetchSuccess([RAW_DRAFT_SUMMARY]);
      const client = new CeoNylasClient('key', 'grant', logger);
      await client.listDrafts({ limit: 10 });

      const url = new URL(fetchSpy.mock.calls[0]![0] as string);
      expect(url.searchParams.get('received_after')).toBeNull();
    });

    it('normalizes the raw draft into a summary with recipients', async () => {
      mockFetchSuccess([RAW_DRAFT_SUMMARY]);
      const client = new CeoNylasClient('key', 'grant', logger);
      const drafts = await client.listDrafts({ limit: 10 });

      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        id: 'draft-1',
        threadId: 'thread-1',
        subject: 'Quarterly update',
        to: [{ name: 'Alice', email: 'alice@example.com' }],
        cc: [{ email: 'bob@example.com' }],
        snippet: 'Hi Alice, here is the update',
        date: 1_700_000_000,
      });
    });
  });

  describe('listAllDrafts (pagination)', () => {
    function pageResponse(data: unknown[], nextCursor?: string) {
      const body: Record<string, unknown> = { data };
      if (nextCursor) body.next_cursor = nextCursor;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    it('follows next_cursor across pages until it is absent', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(pageResponse([{ id: 'd1', subject: 'a', to: [], cc: [] }], 'CUR2'))
        .mockResolvedValueOnce(pageResponse([{ id: 'd2', subject: 'b', to: [], cc: [] }]));
      const client = new CeoNylasClient('key', 'grant', logger);

      const { drafts, truncated } = await client.listAllDrafts({ pageSize: 1, maxScan: 100 });

      expect(drafts.map((d) => d.id)).toEqual(['d1', 'd2']);
      expect(truncated).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // Second request carries the cursor from the first page.
      const url2 = new URL(fetchSpy.mock.calls[1]![0] as string);
      expect(url2.searchParams.get('page_token')).toBe('CUR2');
    });

    it('stops at maxScan and reports truncated when more pages remain', async () => {
      // Every page returns one draft AND a cursor, so pagination would never end
      // on its own — the maxScan ceiling must stop it. A fresh Response per call
      // is required because a Response body can only be read once.
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => pageResponse([{ id: 'x', subject: 's', to: [], cc: [] }], 'MORE'));
      const client = new CeoNylasClient('key', 'grant', logger);

      const { drafts, truncated } = await client.listAllDrafts({ pageSize: 1, maxScan: 3 });

      expect(drafts).toHaveLength(3);
      expect(truncated).toBe(true);
      // 3 pages of 1 each — never runs away past the ceiling.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('stops on the page that contains a stopWhen match', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(pageResponse([
          { id: 'd1', thread_id: 't1', subject: 'a', to: [], cc: [] },
          { id: 'd2', thread_id: 't2', subject: 'b', to: [], cc: [] },
        ], 'CUR2'))
        .mockResolvedValueOnce(pageResponse([
          { id: 'd3', thread_id: 't3', subject: 'c', to: [], cc: [] },
        ]));
      const client = new CeoNylasClient('key', 'grant', logger);

      const { drafts, truncated } = await client.listAllDrafts({
        stopWhen: (draft) => draft.threadId === 't2',
      });

      expect(drafts.map((d) => d.id)).toEqual(['d1', 'd2']);
      expect(truncated).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('stops if a page returns no drafts (defends against an empty-page loop)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(pageResponse([], 'MORE'));
      const client = new CeoNylasClient('key', 'grant', logger);

      const { drafts, truncated } = await client.listAllDrafts({ pageSize: 50, maxScan: 500 });

      expect(drafts).toEqual([]);
      expect(truncated).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDraft', () => {
    it('GETs /drafts/{id} and returns the full draft with body', async () => {
      const fetchSpy = mockFetchSuccess({
        ...RAW_DRAFT_SUMMARY,
        bcc: [{ email: 'carol@example.com' }],
        body: '<p>Hi Alice</p>',
      });
      const client = new CeoNylasClient('key', 'grant', logger);
      const draft = await client.getDraft('draft-1');

      const call = fetchSpy.mock.calls[0]!;
      const url = new URL(call[0] as string);
      expect(url.pathname.endsWith('/drafts/draft-1')).toBe(true);
      expect((call[1] as RequestInit).method).toBe('GET');
      expect(draft.body).toBe('<p>Hi Alice</p>');
      expect(draft.bcc).toEqual([{ name: undefined, email: 'carol@example.com' }]);
    });
  });

  describe('updateDraft', () => {
    it('PUTs /drafts/{id} with only the provided fields and returns the updated draft', async () => {
      const fetchSpy = mockFetchSuccess({
        ...RAW_DRAFT_SUMMARY,
        to: [{ email: 'corrected@example.com' }],
        subject: 'Corrected subject',
        body: '<p>Updated</p>',
        bcc: [],
      });
      const client = new CeoNylasClient('key', 'grant', logger);
      const updated = await client.updateDraft('draft-1', {
        to: [{ email: 'corrected@example.com' }],
        subject: 'Corrected subject',
        body: '<p>Updated</p>',
      });

      const call = fetchSpy.mock.calls[0]!;
      const url = new URL(call[0] as string);
      const init = call[1] as RequestInit;
      expect(url.pathname.endsWith('/drafts/draft-1')).toBe(true);
      expect(init.method).toBe('PUT');

      const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(sentBody).toEqual({
        to: [{ email: 'corrected@example.com' }],
        subject: 'Corrected subject',
        body: '<p>Updated</p>',
      });
      // cc was not provided — it must be absent so we don't blank out the draft's existing CC.
      expect(sentBody).not.toHaveProperty('cc');

      expect(updated.to).toEqual([{ name: undefined, email: 'corrected@example.com' }]);
      expect(updated.subject).toBe('Corrected subject');
      expect(updated.body).toBe('<p>Updated</p>');
    });
  });
});

describe('CeoNylasClient.listFolders (pagination)', () => {
  function pageResponse(data: unknown[], nextCursor?: string) {
    const body: Record<string, unknown> = { data };
    if (nextCursor) body.next_cursor = nextCursor;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('follows next_cursor and includes a folder from the second page', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(pageResponse([{ id: 'INBOX', name: 'INBOX' }], 'CUR2'))
      .mockResolvedValueOnce(pageResponse([{ id: 'Label_39', name: '✍️ Drafted' }]));
    const client = new CeoNylasClient('key', 'grant', logger);

    const folders = await client.listFolders();

    expect(folders).toEqual([
      { id: 'INBOX', name: 'INBOX' },
      { id: 'Label_39', name: '✍️ Drafted' },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const first = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(first.searchParams.get('limit')).toBe('20');
    expect(first.searchParams.has('page_token')).toBe(false);
    const second = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(second.searchParams.get('page_token')).toBe('CUR2');
    expect(second.searchParams.get('limit')).toBe('20');
  });

  it('stops at the scan cap when next_cursor never ends', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => pageResponse(
        Array.from({ length: 20 }, (_, i) => ({ id: `f-${i}`, name: `Folder ${i}` })),
        'MORE',
      ));
    const client = new CeoNylasClient('key', 'grant', logger);

    const folders = await client.listFolders();

    // 25 pages of 20 is the 500-folder ceiling. The next cursor is not followed.
    expect(folders).toHaveLength(500);
    expect(fetchSpy).toHaveBeenCalledTimes(25);
  });

  it('stops when a page is empty even if a cursor is present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(pageResponse([], 'MORE'));
    const client = new CeoNylasClient('key', 'grant', logger);

    const folders = await client.listFolders();

    expect(folders).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CeoNylasClient region', () => {
  it('uses the given apiUri as the base for grant requests', async () => {
    const fetchSpy = mockFetchSuccess([]);
    const client = new CeoNylasClient('key', 'grant-eu', logger, undefined, 'https://api.eu.nylas.com');
    await client.listFolders();
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/^https:\/\/api\.eu\.nylas\.com\/v3\/grants\/grant-eu\//);
  });

  it('defaults to the US API', async () => {
    const fetchSpy = mockFetchSuccess([]);
    const client = new CeoNylasClient('key', 'grant-us', logger);
    await client.listFolders();
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/^https:\/\/api\.us\.nylas\.com\/v3\/grants\/grant-us\//);
  });
});
