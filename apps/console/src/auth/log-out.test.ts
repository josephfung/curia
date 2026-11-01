import { afterEach, describe, expect, it, vi } from 'vitest';
import { endConsoleSession } from './log-out.js';

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('endConsoleSession', () => {
  it('treats 200 as signed out', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { ok: true }));
    expect(await endConsoleSession()).toEqual({ ok: true });
  });

  it('treats 401 Session already ended as signed out', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { error: 'Session already ended.' }));
    expect(await endConsoleSession()).toEqual({ ok: true });
  });

  it('stays put on a 500', async () => {
    vi.stubGlobal('fetch', mockFetch(500, { error: 'Could not sign out. Please try again.' }));
    const result = await endConsoleSession();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Could not sign out');
  });

  it('stays put when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await endConsoleSession();
    expect(result.ok).toBe(false);
  });
});
