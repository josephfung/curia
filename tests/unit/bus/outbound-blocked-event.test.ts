import { describe, it, expect } from 'vitest';
import { createOutboundBlocked } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

describe('outbound.blocked event', () => {
  it('creates an event with correct type and sourceLayer', () => {
    const event = createOutboundBlocked({
      blockId: 'block_test123',
      conversationId: 'email:thread-1',
      channelId: 'email',
      content: 'leaked content here',
      recipientId: 'attacker@example.com',
      reason: 'System prompt fragment detected',
      findings: [{ rule: 'system-prompt-fragment', detail: 'Matched: "You are Test Agent"' }],
      parentEventId: 'evt-response-1',
    });

    expect(event.type).toBe('outbound.blocked');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.payload.blockId).toBe('block_test123');
    expect(event.payload.conversationId).toBe('email:thread-1');
    expect(event.payload.channelId).toBe('email');
    expect(event.payload.content).toBe('leaked content here');
    expect(event.payload.recipientId).toBe('attacker@example.com');
    expect(event.payload.reason).toBe('System prompt fragment detected');
    expect(event.payload.findings).toHaveLength(1);
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.parentEventId).toBe('evt-response-1');
  });

  it('dispatch layer can publish outbound.blocked', () => {
    expect(canPublish('dispatch', 'outbound.blocked')).toBe(true);
  });

  it('channel layer can subscribe to outbound.blocked', () => {
    expect(canSubscribe('channel', 'outbound.blocked')).toBe(true);
  });

  it('system layer can publish and subscribe to outbound.blocked', () => {
    expect(canPublish('system', 'outbound.blocked')).toBe(true);
    expect(canSubscribe('system', 'outbound.blocked')).toBe(true);
  });

  it('agent layer cannot publish outbound.blocked', () => {
    expect(canPublish('agent', 'outbound.blocked')).toBe(false);
  });
});
