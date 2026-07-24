import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../../../src/bus/bus.js';
import { SmsAdapter } from '../../../../src/channels/sms/sms-adapter.js';
import type { SmsClient } from '../../../../src/channels/sms/sms-client.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { SmsOptOutStore } from '../../../../src/channels/sms/sms-opt-out.js';
import { SmsWebhookBridge } from '../../../../src/channels/sms/webhook-bridge.js';
import { createLogger } from '../../../../src/logger.js';
import pino from 'pino';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { OutboundMessageEvent } from '../../../../src/bus/events.js';

function makeSilentLogger() {
  return pino({ level: 'silent' });
}

function telnyxKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    privateKey,
    publicKeyBase64: spki.subarray(-32).toString('base64'),
  };
}

function signBody(rawBody: Buffer, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = Buffer.concat([
    Buffer.from(timestamp, 'utf8'),
    Buffer.from('|', 'utf8'),
    rawBody,
  ]);
  return {
    timestamp,
    signature: sign(null, signed, privateKey).toString('base64'),
  };
}

describe('SmsAdapter', () => {
  let bus: EventBus;
  let bridge: SmsWebhookBridge;
  let client: SmsClient;
  let gateway: OutboundGateway;
  let contactService: ContactService;
  let optOutStore: SmsOptOutStore;
  let adapter: SmsAdapter;
  let keys: ReturnType<typeof telnyxKeyPair>;

  beforeEach(async () => {
    keys = telnyxKeyPair();
    bus = new EventBus(createLogger('error'));
    bridge = new SmsWebhookBridge();
    client = {
      fromNumber: '+14155550000',
      webhookPublicKey: keys.publicKeyBase64,
      sendSms: vi.fn().mockResolvedValue({ messageId: 'msg_out' }),
    } as unknown as SmsClient;
    gateway = {
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'msg_out' }),
    } as unknown as OutboundGateway;
    contactService = {
      ensureChannelContact: vi.fn().mockResolvedValue({
        contactId: 'c1',
        tier: 'unknown',
        created: true,
      }),
    } as unknown as ContactService;
    optOutStore = {
      isOptedOut: vi.fn().mockResolvedValue(false),
      recordOptOut: vi.fn().mockResolvedValue(undefined),
      clearOptOut: vi.fn().mockResolvedValue(undefined),
    } as unknown as SmsOptOutStore;

    adapter = new SmsAdapter({
      bus,
      logger: makeSilentLogger(),
      client,
      outboundGateway: gateway,
      contactService,
      optOutStore,
      webhookBridge: bridge,
    });
    await adapter.start();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  it('rejects invalid signatures', async () => {
    const rawBody = Buffer.from('{}');
    const result = await bridge.getHandler()!(rawBody, {
      signature: Buffer.alloc(64).toString('base64'),
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    expect(result.status).toBe(401);
  });

  it('publishes inbound SMS and auto-creates contact', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    const payload = {
      data: {
        event_type: 'message.received',
        id: 'evt_pub',
        payload: {
          id: 'msg_in',
          text: 'Hello Curia',
          from: { phone_number: '+14155552671' },
          to: [{ phone_number: '+14155550000' }],
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const { signature, timestamp } = signBody(rawBody, keys.privateKey);

    const result = await bridge.getHandler()!(rawBody, { signature, timestamp });
    expect(result.status).toBe(200);
    expect(contactService.ensureChannelContact).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'sms',
        channelIdentifier: '+14155552671',
        source: 'sms_participant',
      }),
    );
    expect(published).toHaveLength(1);
    const event = published[0] as { payload: { channelId: string; conversationId: string; senderId: string; content: string } };
    expect(event.payload.channelId).toBe('sms');
    expect(event.payload.conversationId).toBe('sms:+14155552671');
    expect(event.payload.senderId).toBe('+14155552671');
    expect(event.payload.content).toBe('Hello Curia');
  });

  it('handles STOP without publishing inbound.message', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    const payload = {
      data: {
        event_type: 'message.received',
        id: 'evt_stop',
        payload: {
          text: 'STOP',
          from: { phone_number: '+14155552671' },
        },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const { signature, timestamp } = signBody(rawBody, keys.privateKey);

    await bridge.getHandler()!(rawBody, { signature, timestamp });
    expect(optOutStore.recordOptOut).toHaveBeenCalledWith('+14155552671');
    expect(client.sendSms).toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it('routes outbound.message through the gateway', async () => {
    const outbound = {
      id: 'evt-out',
      type: 'outbound.message',
      payload: {
        channelId: 'sms',
        conversationId: 'sms:+14155552671',
        content: 'Reply text',
        taskEventId: 'task-1',
      },
    } as unknown as OutboundMessageEvent;

    // Re-trigger via bus publish (adapter subscribed in start)
    await bus.publish('dispatch', outbound);
    // Allow async subscriber
    await new Promise((r) => setTimeout(r, 10));

    expect(gateway.send).toHaveBeenCalledWith(
      { channel: 'sms', recipient: '+14155552671', message: 'Reply text' },
      expect.objectContaining({ conversationId: 'sms:+14155552671' }),
    );
  });

  it('ignores outbound for other channels', async () => {
    await bus.publish('dispatch', {
      id: 'evt-other',
      type: 'outbound.message',
      payload: {
        channelId: 'signal',
        conversationId: 'signal:+14155552671',
        content: 'nope',
      },
    } as unknown as OutboundMessageEvent);
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.send).not.toHaveBeenCalled();
  });
});
