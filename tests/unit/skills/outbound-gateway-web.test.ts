import { describe, expect, it, vi } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { createLogger } from '../../../src/logger.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';
import type { WebPushService } from '../../../src/channels/web/push-service.js';

function gateway(delivery: { outcome: 'delivered' | 'visible' | 'fallback'; detail?: string }, passed = true) {
  const published: BusEvent[] = [];
  const deliver = vi.fn().mockResolvedValue(delivery.detail ? delivery : { outcome: delivery.outcome });
  const check = vi.fn().mockResolvedValue({ passed, findings: passed ? [] : [{ rule: 'blocked', detail: 'no' }] });
  const bus = {
    publish: vi.fn(async (_layer: string, event: BusEvent) => { published.push(event); }),
    subscribe: vi.fn(),
  } as unknown as EventBus;
  const instance = new OutboundGateway({
    contactService: { resolveByChannelIdentity: vi.fn().mockResolvedValue(null) } as unknown as ContactService,
    contentFilter: { check } as unknown as OutboundContentFilter,
    bus,
    logger: createLogger('silent'),
    identityGate: 'off',
    webPush: { deliver } as unknown as WebPushService,
  });
  return { instance, deliver, check, published };
}

describe('outbound gateway web', () => {
  it('runs the content filter and publishes outbound.delivered when the push lands or the thread is open', async () => {
    for (const outcome of ['delivered', 'visible'] as const) {
      const { instance, deliver, check, published } = gateway({ outcome });
      const result = await instance.send({ channel: 'web', recipient: 'principal', message: 'The board moved.' });
      expect(result.success).toBe(true);
      expect(check).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'web', content: 'The board moved.' }));
      expect(deliver).toHaveBeenCalledWith('The board moved.');
      expect(published.some((event) => event.type === 'outbound.delivered')).toBe(true);
    }
  });

  it('does not publish a delivery when the phone falls back or the filter blocks', async () => {
    const blocked = gateway({ outcome: 'delivered' }, false);
    const blockedResult = await blocked.instance.send({ channel: 'web', recipient: 'principal', message: 'secret' });
    expect(blockedResult.success).toBe(false);
    expect(blocked.deliver).not.toHaveBeenCalled();
    expect(blocked.published.some((event) => event.type === 'outbound.delivered')).toBe(false);

    const fallback = gateway({ outcome: 'fallback', detail: 'The phone stopped receiving notifications.' });
    const fallbackResult = await fallback.instance.send({ channel: 'web', recipient: 'principal', message: 'hello' });
    expect(fallbackResult.success).toBe(false);
    expect(fallbackResult.webDelivery).toBe('fallback');
    expect(fallback.published.some((event) => event.type === 'outbound.delivered')).toBe(false);
  });
});
