import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { CeoInboxArchiveHandler } from './handler.js';
import { ExecutionLayer } from '../../../../src/skills/execution.js';
import { ToolRegistry } from '../../../../src/skills/registry.js';
import type { ToolContext, ToolManifest } from '../../../../src/skills/types.js';

const logger = pino({ level: 'silent' });

function buildCtx(input: Record<string, unknown>, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    secret(key: string): string {
      switch (key) {
        case 'nylas_api_key': return 'test-api-key';
        case 'ceo_nylas_grant_id': return 'test-grant-id';
        default: throw new Error(`unknown secret: ${key}`);
      }
    },
    log: logger,
    ...extra,
  } as unknown as ToolContext;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? { data } : { error: data }), { status });
}

/** The fetch calls made, as "METHOD /path". */
function calls(spy: MockInstance<typeof fetch>): string[] {
  return spy.mock.calls.map(([url, init]) => {
    const method = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return `${method} ${new URL(String(url)).pathname.replace(/^.*\/grants\/[^/]+/, '')}`;
  });
}

describe('CeoInboxArchiveHandler', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('archives by writing the folders back without INBOX', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX', 'Label_3'] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['Label_3'] }));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result.success).toBe(true);
    expect(calls(fetchSpy)).toEqual(['GET /messages/19a2b3c4d5e6f708', 'PUT /messages/19a2b3c4d5e6f708']);
    const putBody = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body));
    expect(putBody).toEqual({ folders: ['Label_3'] });
  });

  // The two malformed IDs from the prod audit_log behind #2083.
  it.each([
    ['9b359f65-placeholder', /placeholder text/],
    ['1a102a493eca2fc54', /17 hex digits/],
  ])('rejects %s before any Nylas call', async (messageId, problem) => {
    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: messageId }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorType).toBe('VALIDATION_ERROR');
    expect(result.error).toMatch(problem);
    expect(result.error).toContain('Do not retry');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a 404 as message not found, not a bare failure', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ type: 'not_found_error' }, 404));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorType).toBe('NOT_FOUND');
    expect(result.error).toMatch(/Message not found.*Do not retry with this ID/);
  });

  it('sends no PUT when the read returns after the call was aborted', async () => {
    const abort = new AbortController();
    // A fetch that ignores the signal: the read still comes back, late.
    fetchSpy.mockImplementationOnce(async () => {
      abort.abort();
      return jsonResponse({ id: 'm1', folders: ['INBOX'] });
    });

    const result = await new CeoInboxArchiveHandler().execute(
      buildCtx({ message_id: '19a2b3c4d5e6f708' }, { signal: abort.signal }),
    );

    expect(result.success).toBe(false);
    expect(calls(fetchSpy)).toEqual(['GET /messages/19a2b3c4d5e6f708']);
  });

  it('sends no PUT after the execution layer times the call out', async () => {
    vi.stubEnv('NYLAS_API_KEY', 'test-api-key');
    vi.stubEnv('CEO_NYLAS_GRANT_ID', 'test-grant-id');
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, 'tool.json'), 'utf8'),
    ) as ToolManifest;
    const registry = new ToolRegistry();
    registry.register({ ...manifest, timeout: 50 }, new CeoInboxArchiveHandler());
    const execution = new ExecutionLayer(registry, logger);

    // A slow read, like the 10–15 s Nylas bursts in prod. It honours the abort
    // signal the way a real fetch does.
    fetchSpy.mockImplementation((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        const timer = setTimeout(() => {
          const isPut = (init as RequestInit | undefined)?.method === 'PUT';
          resolve(jsonResponse({ id: 'm1', folders: isPut ? [] : ['INBOX'] }));
        }, 200);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    );

    const result = await execution.invoke('ceo-inbox-archive', { message_id: '19a2b3c4d5e6f708' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('timed out');

    // Give the abandoned handler time to finish what it would have done.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls(fetchSpy)).toEqual(['GET /messages/19a2b3c4d5e6f708']);
  });
});
