import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSearchHandler } from '../../../skills/web-search/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  secretValue = 'tvly-test-key',
): SkillContext {
  return {
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

  it('returns failure when API key is missing', async () => {
    const ctx: SkillContext = {
      input: { query: 'test' },
      secret: () => { throw new Error('Secret not set'); },
      log: logger,
    };
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('API key');
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

  it('returns failure on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    const result = await handler.execute(makeCtx({ query: 'test' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('401');
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

    // Assert Authorization header is set correctly and api_key is NOT in the body
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer tvly-test-key');
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.search_depth).toBe('advanced');
    expect(body).not.toHaveProperty('api_key');
  });

  it('defaults to basic search_depth', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await handler.execute(makeCtx({ query: 'test' }));

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];

    // Assert Authorization header is set correctly and api_key is NOT in the body
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer tvly-test-key');
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.search_depth).toBe('basic');
    expect(body).not.toHaveProperty('api_key');
  });
});
