import { describe, it, expect } from 'vitest';
import { createSecretChanged } from '../../../src/bus/events.js';
import { serializeForLeakCheck } from '../../helpers/leak-check.js';

describe('serializeForLeakCheck', () => {
  it("blanks the envelope's generated id and timestamp", () => {
    const event = { ...createSecretChanged({ secretName: 'user.card', action: 'set', stage: 'completed', initiatedBy: 'session' }),
      id: '00000000-0000-4000-8000-000000000456', timestamp: new Date('2026-01-01T00:00:00.456Z') };
    const text = serializeForLeakCheck([event]);
    expect(text).not.toContain('456');
    expect(text).toContain('"id":"<id>"');
    expect(text).toContain('"timestamp":"<timestamp>"');
  });

  it('keeps UUID-shaped values in the payload, so a leak there still shows', () => {
    const event = createSecretChanged({ secretName: 'user.card', action: 'set', stage: 'completed', initiatedBy: 'session',
      actorSessionId: '00000000-0000-4000-8000-000000000456' });
    expect(serializeForLeakCheck([event])).toContain('456');
  });

  it("keeps a payload's own id and timestamp fields", () => {
    const event = { type: 't', payload: { id: '00000000-0000-4000-8000-000000004111', timestamp: '4111' } };
    expect(serializeForLeakCheck(event)).toContain('000000004111');
    expect(serializeForLeakCheck(event)).toContain('"timestamp":"4111"');
  });

  it('keeps an envelope id that is not a UUID', () => {
    expect(serializeForLeakCheck({ type: 't', payload: {}, id: 'cvv-456' })).toContain('cvv-456');
  });
});
