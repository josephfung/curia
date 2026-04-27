import { describe, it, expect } from 'vitest';
import { createOutboundNotification } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

describe('outbound.notification event', () => {
  it('creates a blocked_content notification with correct type and sourceLayer', () => {
    const event = createOutboundNotification({
      notificationType: 'blocked_content',
      ceoEmail: 'ceo@example.com',
      subject: 'Action needed — blocked outbound reply',
      body: 'An outbound message was blocked.\n\nBlock ID: block_abc123',
      blockId: 'block_abc123',
      originalChannel: 'email',
      originalRecipientId: 'third-party@example.com',
      parentEventId: 'evt-blocked-1',
    });

    expect(event.type).toBe('outbound.notification');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.payload.notificationType).toBe('blocked_content');
    expect(event.payload.ceoEmail).toBe('ceo@example.com');
    expect(event.payload.subject).toBe('Action needed — blocked outbound reply');
    expect(event.payload.blockId).toBe('block_abc123');
    expect(event.payload.originalChannel).toBe('email');
    expect(event.payload.originalRecipientId).toBe('third-party@example.com');
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.parentEventId).toBe('evt-blocked-1');
  });

  it('creates a group_held notification without parentEventId', () => {
    const event = createOutboundNotification({
      notificationType: 'group_held',
      ceoEmail: 'ceo@example.com',
      subject: 'Signal group message held — member verification needed',
      body: 'A Signal group message was held.',
      originalChannel: 'signal',
      originalRecipientId: 'groupABCdef==',
    });

    expect(event.type).toBe('outbound.notification');
    expect(event.payload.notificationType).toBe('group_held');
    expect(event.payload.ceoEmail).toBe('ceo@example.com');
    expect(event.parentEventId).toBeUndefined();
    expect(event.payload.blockId).toBeUndefined();
  });

  it('dispatch layer can publish outbound.notification', () => {
    expect(canPublish('dispatch', 'outbound.notification')).toBe(true);
  });

  it('channel layer can subscribe to outbound.notification', () => {
    expect(canSubscribe('channel', 'outbound.notification')).toBe(true);
  });

  it('system layer can publish and subscribe to outbound.notification', () => {
    expect(canPublish('system', 'outbound.notification')).toBe(true);
    expect(canSubscribe('system', 'outbound.notification')).toBe(true);
  });

  it('agent layer cannot publish outbound.notification', () => {
    expect(canPublish('agent', 'outbound.notification')).toBe(false);
  });

  it('channel layer cannot publish outbound.notification', () => {
    expect(canPublish('channel', 'outbound.notification')).toBe(false);
  });
});
