import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSessionInfo, checkSession } from './api.js';

// Builds a minimal fetch mock that returns the given status + JSON body.
function mockFetch(status: number, body: unknown, ct = 'application/json') {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h === 'content-type' ? ct : null) },
    json: () => Promise.resolve(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('getSessionInfo', () => {
  it('returns valid=true configured=true when identity is configured', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { identity: {}, configured: true }));
    expect(await getSessionInfo()).toEqual({ valid: true, configured: true });
  });

  it('returns valid=true configured=false when not yet configured', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { identity: {}, configured: false }));
    expect(await getSessionInfo()).toEqual({ valid: true, configured: false });
  });

  it('returns valid=false on 401', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}));
    expect(await getSessionInfo()).toEqual({ valid: false, configured: false });
  });

  it('returns valid=false on 403', async () => {
    vi.stubGlobal('fetch', mockFetch(403, {}));
    expect(await getSessionInfo()).toEqual({ valid: false, configured: false });
  });

  it('treats non-auth server errors as valid (transient)', async () => {
    vi.stubGlobal('fetch', mockFetch(500, {}));
    expect(await getSessionInfo()).toEqual({ valid: true, configured: true });
  });

  it('returns valid=false when response is HTML (SPA fallback)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, '', 'text/html'));
    expect(await getSessionInfo()).toEqual({ valid: false, configured: false });
  });

  it('returns valid=false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    expect(await getSessionInfo()).toEqual({ valid: false, configured: false });
  });
});

describe('checkSession', () => {
  it('returns true when session is valid', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { configured: true }));
    expect(await checkSession()).toBe(true);
  });

  it('returns false when session is invalid', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}));
    expect(await checkSession()).toBe(false);
  });
});
