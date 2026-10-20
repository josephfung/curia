// autonomy.relay_deferred — a relay to the principal went to the digest (#1320).
import { describe, it, expect } from 'vitest';
import { createAutonomyRelayDeferred } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

describe('autonomy.relay_deferred', () => {
  const event = createAutonomyRelayDeferred({
    originatorContactId: 'contact-1',
    tier: 'known',
    channel: 'signal',
    conversationId: 'signal:+15550000000',
    taskEventId: 'task-1',
    noticeSent: true,
  }, 'task-1');

  it('names the originator, never the message', () => {
    expect(event.type).toBe('autonomy.relay_deferred');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.parentEventId).toBe('task-1');
    expect(Object.keys(event.payload).sort()).toEqual(
      ['channel', 'conversationId', 'noticeSent', 'originatorContactId', 'taskEventId', 'tier'],
    );
  });

  it('is published by dispatch (the gateway) and read only by system (the audit logger)', () => {
    expect(canPublish('dispatch', 'autonomy.relay_deferred')).toBe(true);
    expect(canSubscribe('system', 'autonomy.relay_deferred')).toBe(true);
    expect(canPublish('agent', 'autonomy.relay_deferred')).toBe(false);
    expect(canSubscribe('agent', 'autonomy.relay_deferred')).toBe(false);
    expect(canSubscribe('channel', 'autonomy.relay_deferred')).toBe(false);
  });
});
