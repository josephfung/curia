import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxSearchHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(
  input: Record<string, unknown>,
  opts: { selfEmail?: string } = {},
): SkillContext {
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
    },
  };
}

function mockFetchReturning(messages: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: messages }),
  } as unknown as Response);
}

function extractQueryParam(fetchMock: ReturnType<typeof vi.fn>, param: string): string | null {
  const url = new URL(fetchMock.mock.calls[0][0] as string);
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
});
