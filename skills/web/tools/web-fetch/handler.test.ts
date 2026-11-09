// web-fetch refuses Google Workspace file URLs before any request (prompt trim PR 6).
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { WebFetchHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const logger = pino({ level: 'silent' });

function ctxFor(url: string): ToolContext {
  return { input: { url }, log: logger } as unknown as ToolContext;
}

describe('web-fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a Google Doc without fetching it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await new WebFetchHandler().execute(ctxFor('https://docs.google.com/document/d/1AbC/edit'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/skill-activate with skill "google-workspace"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches other pages', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const result = await new WebFetchHandler().execute(ctxFor('https://example.com/'));
    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('refuses a redirect that lands on a Google file\'s sign-in page', async () => {
    const landed = new Response('<html>Sign in</html>', { status: 200 });
    Object.defineProperty(landed, 'url', { value: 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fdocs.google.com%2Fdocument%2Fd%2F1AbC%2Fedit' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(landed));
    const result = await new WebFetchHandler().execute(ctxFor('https://bit.ly/offsite-plan'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/skill-activate with skill "google-workspace"/);
  });

  it('tells the model not to guess other paths after a 404 (#2149)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not found', { status: 404, statusText: 'Not Found' })));
    const result = await new WebFetchHandler().execute(ctxFor('https://example.com/private-dining'));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/^HTTP 404: Not Found\./);
      expect(result.error).toMatch(/Fetch a URL from a search result/);
    }
  });

  it('reports other HTTP failures by status alone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503, statusText: 'Service Unavailable' })));
    const result = await new WebFetchHandler().execute(ctxFor('https://example.com/'));
    expect(result).toEqual({ success: false, error: 'HTTP 503: Service Unavailable' });
  });

  describe('pages with no readable text (#2546)', () => {
    const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

    it('points to web-browser when only scripts and markup come back', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        html('<html><head><script>window.app = "x";</script><style>a{}</style></head><body>\n  <div id="root"></div>\n</body></html>'),
      ));
      const result = await new WebFetchHandler().execute(ctxFor('https://example.com/'));
      expect(result.success).toBe(true);
      if (result.success) expect((result.data as { note?: string }).note).toMatch(/no readable text.*web-browser/is);
    });

    it('flags a body whose text was cut off by max_length, ignoring the truncation marker', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html(`<script>${'x'.repeat(500)}</script><p>Real text after</p>`)));
      const ctx = { input: { url: 'https://example.com/', max_length: 100 }, log: logger } as unknown as ToolContext;
      const result = await new WebFetchHandler().execute(ctx);
      expect(result.success).toBe(true);
      if (result.success) expect((result.data as { note?: string }).note).toMatch(/web-browser/);
    });

    it('leaves a page with readable text unchanged', async () => {
      const page = '<html><body><p>Open daily</p></body></html>';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html(page)));
      const result = await new WebFetchHandler().execute(ctxFor('https://example.com/'));
      expect(result).toEqual({ success: true, data: { body: page, status: 200, content_type: 'text/html' } });
    });
  });

  it('still refuses private addresses first', async () => {
    const result = await new WebFetchHandler().execute(ctxFor('http://127.0.0.1/'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/internal\/private/);
  });
});
