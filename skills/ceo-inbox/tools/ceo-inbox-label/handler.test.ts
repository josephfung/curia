import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import pino from 'pino';
import { CeoInboxLabelHandler } from './handler.js';
import { clearFolderCache } from '../../../_shared/ceo-nylas-client.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const logger = pino({ level: 'silent' });

function buildCtx(input: Record<string, unknown>): ToolContext {
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
  } as unknown as ToolContext;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? { data } : { error: data }), { status });
}

describe('CeoInboxLabelHandler', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    clearFolderCache();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The spot-check pool (#2159) reads subject/from so a triage sample is gradable. The label
  // flow already reads the message, so naming it must not add a provider call.
  it('returns the subject and sender of the labelled message without an extra call', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([{ id: 'Label_3', name: 'BOARD' }]))
      .mockResolvedValueOnce(jsonResponse({
        id: 'm1', folders: ['INBOX'], subject: 'Statement ready',
        from: [{ name: 'Billing', email: 'billing@example.com' }],
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX', 'Label_3'] }));

    const result = await new CeoInboxLabelHandler().execute(
      buildCtx({ message_id: '19a2b3c4d5e6f708', labels: ['BOARD'] }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      message_id: '19a2b3c4d5e6f708',
      subject: 'Statement ready',
      from: 'Billing (billing@example.com)',
    });
    // list folders, read message, write folders: nothing more than before.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
