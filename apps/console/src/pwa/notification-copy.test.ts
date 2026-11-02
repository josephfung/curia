import { describe, expect, it } from 'vitest';
import { notificationCopy } from './notification-copy.js';

describe('notificationCopy', () => {
  it('names the phone in the installed phone app, with no hint to go elsewhere', () => {
    const copy = notificationCopy({ standalone: true, touch: true });
    expect(copy.noun).toBe('phone');
    expect(copy.turnOn).toBe('Turn on for this phone');
    expect(copy.onStatus).toBe('On for this phone');
    expect(copy.phoneHint).toBeNull();
  });

  it('names the browser on a computer and points to the phone app', () => {
    const copy = notificationCopy({ standalone: false, touch: false });
    expect(copy.noun).toBe('browser');
    expect(copy.intro).toContain('in this browser');
    expect(copy.turnOn).toBe('Turn on for this browser');
    expect(copy.phoneHint).toContain('Curia app on the phone');
  });

  it('names the app when installed on a computer', () => {
    const copy = notificationCopy({ standalone: true, touch: false });
    expect(copy.noun).toBe('app');
    expect(copy.turnOn).toBe('Turn on for this app');
    expect(copy.phoneHint).not.toBeNull();
  });

  it('never mentions "the phone app" as the thing being turned on', () => {
    for (const standalone of [true, false]) {
      for (const touch of [true, false]) {
        expect(notificationCopy({ standalone, touch }).intro).not.toContain('phone app');
      }
    }
  });
});
