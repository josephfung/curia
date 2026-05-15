import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CeoInboxListHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal SkillContext with the given input and an optional Nylas
 *  self-email. The Nylas client is mocked at the fetch level so we can
 *  inspect what `receivedAfter` value gets sent to the API. */
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

/** Capture the URL that fetch was called with and return an empty message
 *  list so the handler completes normally. */
function mockFetchReturning(messages: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: messages }),
  } as unknown as Response);
}

function extractReceivedAfter(fetchMock: ReturnType<typeof vi.fn>): string | null {
  const url = new URL(fetchMock.mock.calls[0][0] as string);
  return url.searchParams.get('received_after');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CeoInboxListHandler — timestamp handling', () => {
  let handler: CeoInboxListHandler;

  beforeEach(() => {
    handler = new CeoInboxListHandler();
  });

  it('accepts a numeric received_after_timestamp and adds +1', async () => {
    const ts = 1_700_000_000;
    const ctx = makeCtx({ received_after_timestamp: ts });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    // The handler should pass ts + 1 to Nylas so "strictly after" semantics hold
    expect(extractReceivedAfter(fetchSpy)).toBe(String(ts + 1));
  });

  it('coerces a string received_after_timestamp to a number and adds +1', async () => {
    const ts = 1_700_000_000;
    const ctx = makeCtx({ received_after_timestamp: String(ts) });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    // String "1700000000" should be coerced, not silently dropped
    expect(extractReceivedAfter(fetchSpy)).toBe(String(ts + 1));
  });

  it('falls back to received_after_hours when timestamp is missing', async () => {
    const ctx = makeCtx({ received_after_hours: 24 });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    const before = Math.floor(Date.now() / 1_000) - 24 * 3600;
    await handler.execute(ctx);
    const after = Math.floor(Date.now() / 1_000) - 24 * 3600;

    const param = Number(extractReceivedAfter(fetchSpy));
    // The hours-based fallback should NOT get the +1 offset — it's already
    // an approximate cutoff, not a high-water mark.
    expect(param).toBeGreaterThanOrEqual(before);
    expect(param).toBeLessThanOrEqual(after + 1);
  });

  it('sends no received_after when both timestamp and hours are missing', async () => {
    const ctx = makeCtx({});
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    expect(extractReceivedAfter(fetchSpy)).toBeNull();
  });

  it('ignores non-numeric, non-coercible timestamp values', async () => {
    const ctx = makeCtx({ received_after_timestamp: 'not-a-number' });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    // Should fall through to no filter (no hours fallback provided either)
    expect(extractReceivedAfter(fetchSpy)).toBeNull();
  });

  it('coerces a float string timestamp correctly', async () => {
    const ctx = makeCtx({ received_after_timestamp: '1700000000.789' });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    // Should floor the float and add +1
    expect(extractReceivedAfter(fetchSpy)).toBe(String(1_700_000_000 + 1));
  });
});
