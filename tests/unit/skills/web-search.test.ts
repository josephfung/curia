import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSearchHandler } from '../../../skills/web/tools/web-search/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  secretValue = 'tvly-test-key',
): ToolContext {
  return {
    toolName: 'web-search',
    toolVersion: '1.2.0',
    input,
    secret: (name: string) => {
      if (name === 'tavily_api_key') return secretValue;
      throw new Error(`Unexpected secret: ${name}`);
    },
    log: logger,
  };
}

describe('WebSearchHandler', () => {
  const handler = new WebSearchHandler();

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns failure when query is missing', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('query');
  });

  it('returns failure when query is empty string', async () => {
    const result = await handler.execute(makeCtx({ query: '' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('query');
  });

  describe('keyless mode (#2445)', () => {
    // A genuinely-missing secret throws a plain Error with no `cause`.
    function keylessCtx(input: Record<string, unknown>): ToolContext {
      return {
        toolName: 'web-search',
        toolVersion: '1.2.0',
        input,
        secret: () => { throw new Error("Secret 'tavily_api_key' is declared but not set in the environment"); },
        log: logger,
      };
    }

    it('searches keyless when no key is set: keyless header, no api_key', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        results: [{ title: 'Example', url: 'https://example.com', content: 'c', score: 0.9 }],
      }), { status: 200 }));
      vi.stubGlobal('fetch', mockFetch);

      const result = await handler.execute(keylessCtx({ query: 'test' }));
      expect(result.success).toBe(true);
      if (result.success) expect((result.data as { count: number }).count).toBe(1);
      const init = mockFetch.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>)['X-Tavily-Access-Mode']).toBe('keyless');
      expect(JSON.parse(init.body as string)).not.toHaveProperty('api_key');
    });

    it('returns a distinct rate-limit error naming both upgrade paths', async () => {
      // Shape recorded from the live API on 2026-11-03: 429 + Retry-After + an
      // hourly_cap_reached body that pushes x402 payment. None of that body is relayed.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { code: 'hourly_cap_reached', message: 'pay via x402 agentic payment', window: 'hour', retry_after_seconds: 34 },
      }), { status: 429, headers: { 'Retry-After': '34' } })));

      const result = await handler.execute(keylessCtx({ query: 'test' }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('temporarily limited');
        expect(result.error).toContain('Settings → Tools → web-search');
        expect(result.error).toContain('add my Tavily key');
        expect(result.error).toContain('about 1 minute');
        expect(result.error).not.toMatch(/x402|pay/i);
      }
    });

    it('does not go keyless on an unexpected secret error (e.g. key not declared)', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      const ctx: ToolContext = {
        ...keylessCtx({ query: 'test' }),
        secret: () => { throw new Error("Secret 'tavily_api_key' is not declared in the manifest for skill 'web-search'"); },
      };
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('not declared');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('still reports a rate limit when Retry-After is absent', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
      const result = await handler.execute(keylessCtx({ query: 'test' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('within the hour');
    });
  });

  it('surfaces vault read failures as operational errors, not missing-secret guidance', async () => {
    const ctx: ToolContext = {
      toolName: 'web-search',
      toolVersion: '1.2.0',
      input: { query: 'test' },
      // The execution layer wraps a vault read failure in an Error with a `cause`
      // (see src/skills/execution.ts). That is an outage, not a misconfiguration —
      // operators must not be sent to the console to "add the key".
      secret: () => {
        throw new Error("Vault read failed for secret 'tavily_api_key': DB connection refused", {
          cause: new Error('DB connection refused'),
        });
      },
      log: logger,
    };
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('vault');
      expect(result.error).not.toContain('not configured');
      expect(result.error).not.toContain('Settings');
    }
    // An outage must not fall back to a keyless search.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns structured results on success', async () => {
    const mockResponse = {
      results: [
        { title: 'Example', url: 'https://example.com', content: 'Some content', score: 0.9 },
        { title: 'Other', url: 'https://other.com', content: 'Other content', score: 0.7 },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await handler.execute(makeCtx({ query: 'ramen near King and Spadina' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: unknown[]; count: number };
      expect(data.count).toBe(2);
      expect(data.results).toHaveLength(2);
    }
  });

  it('returns empty results array when Tavily returns no results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));

    const result = await handler.execute(makeCtx({ query: 'obscure query' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: unknown[]; count: number };
      expect(data.count).toBe(0);
      expect(data.results).toHaveLength(0);
    }
  });

  it('sends the key, not the keyless header, when a key is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await handler.execute(makeCtx({ query: 'test' }));
    expect(result.success).toBe(true);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string).api_key).toBe('tvly-test-key');
    expect(init.headers as Record<string, string>).not.toHaveProperty('X-Tavily-Access-Mode');
  });

  it.each([401, 403])('reports an invalid key when Tavily rejects it (HTTP %i)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"detail":{"error":"Unauthorized"}}', { status })));

    const result = await handler.execute(makeCtx({ query: 'test' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(String(status));
      expect(result.error).toContain('invalid');
      expect(result.error).toContain('Settings → Tools → web-search');
      expect(result.error).not.toContain('tvly-test-key');
    }
  });

  it('reports an exhausted plan when Tavily returns 432', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 432 })));
    const result = await handler.execute(makeCtx({ query: 'test' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('usage limit');
  });

  it('returns a generic failure for other non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }));

    const result = await handler.execute(makeCtx({ query: 'test' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('500');
  });

  it('returns failure on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network timeout')));

    const result = await handler.execute(makeCtx({ query: 'test' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Search failed');
  });

  it('truncates long content fields to 5000 chars', async () => {
    const longContent = 'x'.repeat(10_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'Test', url: 'https://example.com', content: longContent, score: 0.9 }],
      }),
    }));

    const result = await handler.execute(makeCtx({ query: 'test', searchDepth: 'advanced' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: Array<{ content: string }> };
      const content = data.results[0]!.content;
      expect(content.length).toBeGreaterThanOrEqual(5000);
      expect(content.length).toBeLessThanOrEqual(5000 + '[truncated]'.length);
      expect(content.endsWith('[truncated]')).toBe(true);
    }
  });

  it('sends correct search_depth to Tavily', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await handler.execute(makeCtx({ query: 'test', searchDepth: 'advanced' }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');

    // Tavily v1 authenticates via api_key in the body, not Authorization header
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.api_key).toBe('tvly-test-key');
    expect(body.search_depth).toBe('advanced');
  });

  it('defaults to basic search_depth', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await handler.execute(makeCtx({ query: 'test' }));

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.api_key).toBe('tvly-test-key');
    expect(body.search_depth).toBe('basic');
  });
});
