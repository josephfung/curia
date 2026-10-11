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

  it('still refuses private addresses first', async () => {
    const result = await new WebFetchHandler().execute(ctxFor('http://127.0.0.1/'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/internal\/private/);
  });
});
