// web-fetch refuses Google Workspace file URLs before any request (prompt trim PR 6).
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

// Every name resolves to a public address unless a test maps it elsewhere (#2521).
const dnsAnswers = vi.hoisted(() => new Map<string, string>());
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => [{ address: dnsAnswers.get(hostname) ?? '93.184.215.14', family: 4 }]),
}));

import { WebFetchHandler, envProxyFor, pinnedLookup } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const logger = pino({ level: 'silent' });

function ctxFor(url: string): ToolContext {
  return { input: { url }, log: logger } as unknown as ToolContext;
}

describe('web-fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    dnsAnswers.clear();
  });

  describe('with an environment proxy configured (NODE_USE_ENV_PROXY)', () => {
    it('refuses instead of connecting around the proxy', async () => {
      vi.stubEnv('NODE_USE_ENV_PROXY', '1');
      vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp:3128');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const result = await new WebFetchHandler().execute(ctxFor('https://example.com/page'));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/configured HTTP proxy/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a redirect to a scheme whose proxy is set, before requesting it', async () => {
      vi.stubEnv('NODE_USE_ENV_PROXY', '1');
      vi.stubEnv('http_proxy', 'http://proxy.corp:3128');
      const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://plain.example/' } }));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await new WebFetchHandler().execute(ctxFor('https://example.com/'));
      expect(result.success).toBe(false);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('refuses when the proxy is turned on by --use-env-proxy in NODE_OPTIONS', async () => {
      vi.stubEnv('NODE_USE_ENV_PROXY', '');
      vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=512 --use-env-proxy');
      vi.stubEnv('HTTPS_PROXY', 'http://proxy:3128');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const result = await new WebFetchHandler().execute(ctxFor('https://example.com/page'));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/configured HTTP proxy/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('treats --use-env-proxy on the command line (execArgv) as turning the proxy on', () => {
      const url = new URL('https://example.com/');
      expect(envProxyFor(url, { HTTPS_PROXY: 'http://proxy:3128' }, ['--use-env-proxy'])).toBe('http://proxy:3128');
      expect(envProxyFor(new URL('http://example.com/'), { http_proxy: 'http://p:1' }, ['--use-env-proxy=1'])).toBe('http://p:1');
      expect(envProxyFor(url, { HTTPS_PROXY: 'http://proxy:3128' }, ['--no-use-env-proxy'])).toBeNull();
    });

    it('ignores proxy variables when env-proxy routing is off, as Node fetch does', () => {
      expect(envProxyFor(new URL('https://example.com/'), { HTTPS_PROXY: 'http://proxy.corp:3128' }, [])).toBeNull();
      expect(envProxyFor(new URL('https://example.com/'), { NODE_USE_ENV_PROXY: '0', HTTPS_PROXY: 'http://p:1' }, [])).toBeNull();
      expect(envProxyFor(new URL('https://example.com/'), { NODE_USE_ENV_PROXY: '1' }, [])).toBeNull();
      expect(envProxyFor(new URL('https://example.com/'), { NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'http://p:1' }, [])).toBeNull();
    });
  });

  it('refuses a public name that resolves to a private address, without fetching (#2521)', async () => {
    dnsAnswers.set('rebind.example', '127.0.0.1');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await new WebFetchHandler().execute(ctxFor('https://rebind.example/admin'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/private.*rebind\.example/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('hands fetch a dispatcher per hop, with the hostname left in the URL (#2521)', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response('<p>hi</p>', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await new WebFetchHandler().execute(ctxFor('https://example.com/page'));
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://example.com/page');
    expect((fetchSpy.mock.calls[0]![1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });

  describe('pinnedLookup', () => {
    const lookupWith = (addresses: string[], options: { all?: boolean; family?: number | string } | undefined) =>
      new Promise<{ err: Error | null; result: unknown }>((resolve) => {
        pinnedLookup(addresses)('example.com', options, (err, result) => resolve({ err, result }));
      });

    it('answers only with the vetted addresses, whatever name is asked for', async () => {
      const vetted = ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'];
      const all = await lookupWith(vetted, { all: true });
      expect((all.result as Array<{ address: string }>).map((a) => a.address)).toEqual(vetted);
      const one = await lookupWith(vetted, {});
      expect(vetted).toContain(one.result);
    });

    it('never falls back to another family, and errors when none is vetted', async () => {
      const v4 = await lookupWith(['93.184.215.14'], { family: 4, all: true });
      expect((v4.result as Array<{ address: string }>).map((a) => a.address)).toEqual(['93.184.215.14']);
      const v6 = await lookupWith(['93.184.215.14'], { family: 6, all: true });
      expect(v6.err).not.toBeNull();
      expect(v6.result).toEqual([]);
    });
  });

  it('refuses a redirect to an internal address before requesting it (#2521)', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const result = await new WebFetchHandler().execute(ctxFor('https://short.example/x'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/169\.254\.169\.254/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('follows a redirect to a public host', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/moved' } }))
      .mockResolvedValueOnce(new Response('<p>Moved here</p>', { status: 200, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await new WebFetchHandler().execute(ctxFor('https://example.com/old'));
    expect(result.success).toBe(true);
    expect(String(fetchSpy.mock.calls[1]![0])).toBe('https://example.com/moved');
  });

  it('stops after too many redirects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/again' } })));
    const result = await new WebFetchHandler().execute(ctxFor('https://loop.example/'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Too many redirects/);
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

    it('flags a JS shell that has a title and a noscript message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        html('<html><head><title>App</title></head><body><noscript>You need to enable JavaScript</noscript><div id="root"></div></body></html>'),
      ));
      const result = await new WebFetchHandler().execute(ctxFor('https://example.com/'));
      expect(result.success).toBe(true);
      if (result.success) expect((result.data as { note?: string }).note).toMatch(/no readable text/);
    });

    it.each(['system', 'instruction', 'prompt', 'role'])('flags a page whose only text is inside <%s>, which output sanitization removes', async (tag) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html(`<html><body><${tag}>hello</${tag}></body></html>`)));
      const result = await new WebFetchHandler().execute(ctxFor('https://example.com/'));
      expect(result.success).toBe(true);
      if (result.success) expect((result.data as { note?: string }).note).toMatch(/no readable text/);
    });

    it('words the note for an agent that has no web-browser', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html('<div id="root"></div>')));
      const result = await new WebFetchHandler().execute(ctxFor('https://example.com/'));
      expect(result.success).toBe(true);
      if (result.success) expect((result.data as { note?: string }).note).toMatch(/if you have it, otherwise report/);
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
