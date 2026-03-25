import { describe, it, expect, vi } from 'vitest';
import { WebFetchHandler } from '../../../skills/web-fetch/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets needed'); },
    log: logger,
  };
}

describe('WebFetchHandler', () => {
  const handler = new WebFetchHandler();

  it('returns failure for missing url input', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('url');
    }
  });

  it('returns failure for invalid URL', async () => {
    const result = await handler.execute(makeCtx({ url: 'not-a-url' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid URL');
    }
  });

  it('rejects non-HTTP(S) protocols', async () => {
    const result = await handler.execute(makeCtx({ url: 'file:///etc/passwd' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('HTTPS');
    }
  });

  it('truncates response body to max_length', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => h === 'content-type' ? 'text/html' : null },
      text: async () => 'x'.repeat(50000),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handler.execute(makeCtx({ url: 'https://example.com', max_length: 1000 }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { body: string };
      expect(data.body.length).toBeLessThanOrEqual(1000 + '[truncated]'.length);
    }

    vi.unstubAllGlobals();
  });

  it('returns structured data on successful fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => h === 'content-type' ? 'text/html' : null },
      text: async () => '<html><body>Hello world</body></html>',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handler.execute(makeCtx({ url: 'https://example.com' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { body: string; status: number; content_type: string };
      expect(data.status).toBe(200);
      expect(data.body).toContain('Hello world');
      expect(data.content_type).toBe('text/html');
    }

    vi.unstubAllGlobals();
  });

  it('returns failure for non-OK HTTP responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => 'Not Found',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handler.execute(makeCtx({ url: 'https://example.com/nope' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('404');
    }

    vi.unstubAllGlobals();
  });
});
