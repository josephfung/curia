import { describe, it, expect } from 'vitest';
import { createContactResolved, createContactUnknown } from '../../../src/bus/events.js';

describe('Contact bus events', () => {
  it('creates a contact.resolved event', () => {
    const event = createContactResolved({
      contactId: 'contact-123',
      displayName: 'Jenna Torres',
      role: 'CFO',
      kgNodeId: 'node-456',
      verificationStatus: 'verified',
      channel: 'telegram',
      channelIdentifier: '12345',
      parentEventId: 'inbound-event-id',
    });
    expect(event.type).toBe('contact.resolved');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.payload.displayName).toBe('Jenna Torres');
  });

  it('creates a contact.unknown event', () => {
    const event = createContactUnknown({
      channel: 'telegram',
      senderId: '99999',
      parentEventId: 'inbound-event-id',
    });
    expect(event.type).toBe('contact.unknown');
    expect(event.sourceLayer).toBe('dispatch');
  });
});
