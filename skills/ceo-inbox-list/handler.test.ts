import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CeoInboxListHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal SkillContext. The Nylas client is mocked at the fetch
 *  level so we can inspect the `receivedAfter` query param. */
function makeCtx(
  input: Record<string, unknown>,
  opts: { selfEmail?: string; storedWatermark?: string | null } = {},
): SkillContext {
  // Build a minimal EntityMemory mock that returns the desired stored watermark.
  let entityMemory: EntityMemory | undefined;
  if (opts.storedWatermark !== undefined) {
    const storedValue = opts.storedWatermark;
    // ConfigStore.get() calls findEntities then getFacts.
    const anchorNode = { id: 'anchor-1', label: 'config:ceo_inbox', type: 'concept', properties: {} };
    const factNode =
      storedValue !== null
        ? {
            id: 'fact-1',
            label: 'last_processed_at',
            properties: { key: 'last_processed_at', value: storedValue, namespace: 'ceo_inbox' },
            temporal: { lastConfirmedAt: new Date() },
          }
        : undefined;

    entityMemory = {
      findEntities: vi.fn().mockResolvedValue([anchorNode]),
      getFacts: vi.fn().mockResolvedValue(factNode ? [factNode] : []),
      storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'updated' }),
    } as unknown as EntityMemory;
  }

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
    entityMemory,
  };
}

function mockFetchReturning(messages: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: messages }),
  } as unknown as Response);
}

function extractReceivedAfter(fetchMock: ReturnType<typeof vi.fn>): string | null {
  const url = new URL(fetchMock.mock.calls[0]![0] as string);
  return url.searchParams.get('received_after');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CeoInboxListHandler — watermark handling (#866)', () => {
  let handler: CeoInboxListHandler;

  beforeEach(() => {
    handler = new CeoInboxListHandler();
  });

  it('uses ConfigStore watermark + 1 as receivedAfter when entityMemory is wired', async () => {
    const storedTs = 1_700_000_000;
    const ctx = makeCtx({}, { storedWatermark: String(storedTs) });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    expect(extractReceivedAfter(fetchSpy)).toBe(String(storedTs + 1));
  });

  it('falls back to received_after_hours when no watermark is stored', async () => {
    // entityMemory returns null (no stored fact) → handler uses hours fallback
    const ctx = makeCtx({ received_after_hours: 24 }, { storedWatermark: null });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    const before = Math.floor(Date.now() / 1_000) - 24 * 3600;
    await handler.execute(ctx);
    const after = Math.floor(Date.now() / 1_000) - 24 * 3600;

    const param = Number(extractReceivedAfter(fetchSpy));
    expect(param).toBeGreaterThanOrEqual(before);
    expect(param).toBeLessThanOrEqual(after + 1);
  });

  it('applies the 24h hard default when entityMemory is absent and no hours supplied', async () => {
    // No entityMemory, no received_after_hours
    const ctx = makeCtx({});
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    const before = Math.floor(Date.now() / 1_000) - 24 * 3600;
    await handler.execute(ctx);
    const after = Math.floor(Date.now() / 1_000) - 24 * 3600;

    const param = Number(extractReceivedAfter(fetchSpy));
    expect(param).toBeGreaterThanOrEqual(before);
    expect(param).toBeLessThanOrEqual(after + 1);
  });

  it('falls back to default lookback on a future watermark and emits a warn log', async () => {
    const futureTs = Math.floor(Date.now() / 1_000) + 29 * 24 * 3600; // 29 days in future
    const ctx = makeCtx({}, { storedWatermark: String(futureTs) });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    const before = Math.floor(Date.now() / 1_000) - 24 * 3600;
    await handler.execute(ctx);
    const after = Math.floor(Date.now() / 1_000) - 24 * 3600;

    // Must have warned about the future watermark
    const warnCalls = (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      warnCalls.some((call: unknown[]) => typeof call[1] === 'string' && call[1].includes('future')),
    ).toBe(true);

    // receivedAfter must be the 24h default (not the future timestamp + 1, which would return nothing)
    const param = Number(extractReceivedAfter(fetchSpy));
    expect(param).toBeGreaterThanOrEqual(before);
    expect(param).toBeLessThanOrEqual(after + 1);
  });

  it('coerces a float string watermark from ConfigStore correctly', async () => {
    const ctx = makeCtx({}, { storedWatermark: '1700000000.789' });
    const fetchSpy = mockFetchReturning();
    vi.stubGlobal('fetch', fetchSpy);

    await handler.execute(ctx);

    // Should floor the float and add +1
    expect(extractReceivedAfter(fetchSpy)).toBe(String(1_700_000_000 + 1));
  });

  it('filters out messages sent from curiaEmail', async () => {
    const self = 'curia@example.com';
    const ctx = makeCtx({}, { selfEmail: self, storedWatermark: null });
    const fetchSpy = mockFetchReturning([
      { id: 'm1', threadId: 't1', date: 1, subject: 'a', from: [{ email: self, name: 'Curia' }], to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [] },
      { id: 'm2', threadId: 't2', date: 2, subject: 'b', from: [{ email: 'other@x.com', name: 'Other' }], to: [], cc: [], snippet: '', unread: true, folders: ['INBOX'], attachments: [] },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(1);
  });
});
