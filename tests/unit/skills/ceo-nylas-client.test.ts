import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

// We can't easily mock global fetch per-test with vi.fn(), so instead we
// test the CeoNylasClient by spying on global.fetch and inspecting the URL
// it receives — that's where the folder alias normalization is observable.

const logger = pino({ level: 'silent' });

// Dynamically import after setting up the fetch mock so the module-level
// constant (`NYLAS_BASE`) picks up correctly.
let CeoNylasClient: typeof import('../../../skills/_shared/ceo-nylas-client.js').CeoNylasClient;

beforeEach(async () => {
  vi.restoreAllMocks();
  // Re-import to ensure a clean module state
  const mod = await import('../../../skills/_shared/ceo-nylas-client.js');
  CeoNylasClient = mod.CeoNylasClient;
});

function mockFetchSuccess(data: unknown = []) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('CeoNylasClient.listMessages — folder alias normalization', () => {
  it('normalizes DRAFTS to DRAFT for Gmail compatibility', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'DRAFTS' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('DRAFT');
  });

  it('passes INBOX unchanged (no alias needed)', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'INBOX' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('INBOX');
  });

  it('passes DRAFT unchanged (already correct)', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'DRAFT' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('DRAFT');
  });

  it('passes custom label names through unmodified', async () => {
    const fetchSpy = mockFetchSuccess();
    const client = new CeoNylasClient('key', 'grant', logger);
    await client.listMessages({ folder: 'Label_42' });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('in')).toBe('Label_42');
  });
});
