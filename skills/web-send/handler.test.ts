import { describe, expect, it, vi } from 'vitest';
import { WebSendHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { OutboundSendResult } from '../../src/skills/outbound-gateway.js';

function ctx(send: (request: { channel: string }) => Promise<OutboundSendResult>, resolveOk = true): ToolContext {
  return {
    input: { recipient: 'principal', message: 'The board moved to Thursday.' },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    outboundGateway: {
      send,
      resolveRecipientReference: vi.fn(async (channel: string) => (
        resolveOk && channel === 'signal'
          ? { ok: true, identifier: '+15555550123', kind: 'alias', contactId: 'c1' }
          : { ok: false, error: 'no identity' }
      )),
    },
  } as unknown as ToolContext;
}

describe('web-send', () => {
  const handler = new WebSendHandler();

  it('refuses anyone but the principal', async () => {
    const result = await handler.execute({
      input: { recipient: 'someone-else', message: 'hi' },
      log: { error: vi.fn() },
    } as unknown as ToolContext);
    expect(result.success).toBe(false);
  });

  it('reports a busy push service without trying another channel', async () => {
    const send = vi.fn(async () => ({
      success: false,
      webDelivery: 'unavailable' as const,
      blockedReason: 'The push service is busy.',
    }));
    const result = await handler.execute(ctx(send));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/busy/);
    expect(send).toHaveBeenCalledOnce();
  });

  it('sends the next channel when the phone subscription is dead', async () => {
    const send = vi.fn(async (request: { channel: string }) => {
      if (request.channel === 'web') {
        return {
          success: false,
          webDelivery: 'fallback' as const,
          webDeliveryDetail: 'The phone stopped receiving notifications.',
          blockedReason: 'The phone stopped receiving notifications.',
        };
      }
      return { success: true };
    });
    const result = await handler.execute(ctx(send));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        channel: 'signal',
        app_notice: 'The phone stopped receiving notifications.',
      });
    }
    expect(send).toHaveBeenCalledTimes(2);
  });
});
