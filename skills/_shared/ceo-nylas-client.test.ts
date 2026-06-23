import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoNylasClient, NylasApiError } from './ceo-nylas-client.js';
import type { Logger } from '../../src/logger.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeClient(log: Logger = makeLogger()): CeoNylasClient {
  return new CeoNylasClient('test-api-key', 'test-grant-id', log);
}

/** Build a Response-like object that fetch() would return. */
function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function successResponse(data: unknown): Response {
  return makeResponse(200, { data });
}

function rateLimitResponse(retryAfter?: string): Response {
  const headers: Record<string, string> = {};
  if (retryAfter !== undefined) headers['retry-after'] = retryAfter;
  return makeResponse(429, { error: { type: 'rate_limit_error', message: 'Too many requests' } }, headers);
}

// ── Retry / backoff tests ────────────────────────────────────────────────────

describe('CeoNylasClient — 429 retry / backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries on 429 and succeeds when the next attempt returns 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse())
      .mockResolvedValue(successResponse([{ id: 'f1', name: 'INBOX' }]));

    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    // listFolders uses request() → requestWithCursor() internally
    const promise = client.listFolders();

    // Advance timers so the backoff delay resolves without real waiting.
    await vi.runAllTimersAsync();
    const folders = await promise;

    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe('INBOX');
    // Called twice: once for the 429, once for the successful retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors the Retry-After header for the backoff delay', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse('3'))
      .mockResolvedValue(successResponse([{ id: 'f1', name: 'INBOX' }]));

    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const promise = client.listFolders();
    await vi.runAllTimersAsync();
    await promise;

    // The first setTimeout call should be for ~3000ms (Retry-After: 3 + ±25% jitter).
    const firstDelay = setTimeoutSpy.mock.calls[0]?.[1];
    expect(firstDelay).toBeGreaterThanOrEqual(3000 * 0.75);
    expect(firstDelay).toBeLessThanOrEqual(3000 * 1.25);
  });

  it('throws a typed NylasApiError(429) when retries are exhausted', async () => {
    // Always return 429 — exhaust all 3 retries.
    const fetchMock = vi.fn().mockResolvedValue(rateLimitResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    let caughtErr: unknown;
    const promise = client.listFolders().catch((err: unknown) => {
      caughtErr = err;
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(caughtErr).toBeInstanceOf(NylasApiError);
    const err = caughtErr as NylasApiError;
    // Must be typed status 429.
    expect(err.status).toBe(429);
    const msg = err.message.toLowerCase();
    // Must NOT imply an auth failure (words that would prompt "re-auth" advice).
    expect(msg).not.toMatch(/\bexpired\b|\bre-authoriz|\binvalid.token|\btoken.expired/);
    // Must explicitly say rate-limited or 429 so downstream agents can identify
    // this as transient congestion rather than an auth/credentials problem.
    expect(msg).toMatch(/rate.limit|429/);

    // 1 initial attempt + 3 retries = 4 total fetches.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry non-retriable errors (4xx other than 429)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(400, { error: 'bad request' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    let caughtErr: unknown;
    const promise = client.listFolders().catch((e: unknown) => {
      caughtErr = e;
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(caughtErr).toBeInstanceOf(NylasApiError);
    // No retry — only one fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retriable errors (401 Unauthorized)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(401, { error: 'unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    let caughtErr: unknown;
    const promise = client.listFolders().catch((e: unknown) => {
      caughtErr = e;
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(caughtErr).toBeInstanceOf(NylasApiError);
    expect((caughtErr as NylasApiError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── limit clamping tests ─────────────────────────────────────────────────────

describe('CeoNylasClient — list limit clamping (≤ 20)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clamps listMessages limit when caller passes > 20', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await client.listMessages({ limit: 50 });

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('limit')).toBe('20');
  });

  it('preserves listMessages limit when caller passes ≤ 20', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await client.listMessages({ limit: 10 });

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('limit')).toBe('10');
  });

  it('clamps listDrafts limit when caller passes > 20', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await client.listDrafts({ limit: 100 });

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('limit')).toBe('20');
  });

  it('clamps listAllDrafts pageSize to 20', async () => {
    // Return an empty page with no cursor so the loop exits after one fetch.
    const fetchMock = vi.fn().mockResolvedValue(successResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    // Pass a pageSize that exceeds the cap.
    await client.listAllDrafts({ pageSize: 100 });

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('limit')).toBe('20');
  });

  it('clamps listAllDrafts default pageSize (previously 100) to 20', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await client.listAllDrafts();

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('limit')).toBe('20');
  });
});
