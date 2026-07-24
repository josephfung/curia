import { describe, it, expect, vi } from 'vitest';
import {
  buildSmsConversationId,
  convertTelnyxWebhook,
  normalizeE164,
  parseSmsConversationId,
} from '../../../../src/channels/sms/message-converter.js';

describe('SMS message-converter', () => {
  it('builds and parses sms:<E.164> conversation ids', () => {
    expect(buildSmsConversationId('+14155552671')).toBe('sms:+14155552671');
    expect(parseSmsConversationId('sms:+14155552671')).toBe('+14155552671');
    expect(parseSmsConversationId('sms:not-a-phone')).toBeNull();
    expect(parseSmsConversationId('signal:+14155552671')).toBeNull();
  });

  it('normalizes well-formed E.164 only', () => {
    expect(normalizeE164('+14155552671')).toBe('+14155552671');
    expect(normalizeE164('  +14155552671  ')).toBe('+14155552671');
    expect(normalizeE164('4155552671')).toBeNull();
    expect(normalizeE164(undefined)).toBeNull();
  });

  it('converts message.received webhooks to inbound fields', () => {
    const converted = convertTelnyxWebhook({
      data: {
        event_type: 'message.received',
        id: 'evt_1',
        payload: {
          id: 'msg_1',
          type: 'SMS',
          text: 'Hello from peer',
          from: { phone_number: '+14155552671' },
          to: [{ phone_number: '+14155550000' }],
          direction: 'inbound',
        },
      },
    });
    expect(converted).toEqual({
      conversationId: 'sms:+14155552671',
      channelId: 'sms',
      senderId: '+14155552671',
      content: 'Hello from peer',
      metadata: {
        telnyxMessageId: 'msg_1',
        telnyxEventId: 'evt_1',
        toNumber: '+14155550000',
        direction: 'inbound',
      },
    });
  });

  it('publishes STOP text as ordinary content (no keyword filter)', () => {
    const converted = convertTelnyxWebhook({
      data: {
        event_type: 'message.received',
        id: 'evt_stop',
        payload: {
          text: 'STOP',
          from: { phone_number: '+14155552671' },
        },
      },
    });
    expect(converted?.content).toBe('STOP');
  });

  it('ignores non-inbound events and bad payloads', () => {
    expect(convertTelnyxWebhook({ data: { event_type: 'message.sent' } })).toBeNull();
    expect(convertTelnyxWebhook({
      data: {
        event_type: 'message.received',
        payload: { text: 'hi', from: { phone_number: 'bad' } },
      },
    })).toBeNull();
    expect(convertTelnyxWebhook({
      data: {
        event_type: 'message.received',
        payload: { text: '   ', from: { phone_number: '+14155552671' } },
      },
    })).toBeNull();
  });
});
