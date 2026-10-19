import { describe, it, expect } from 'vitest';
import { CodeTracker } from '../../../src/verification/code-tracker.js';

const TOKEN = '[sign-in code]';

function makeTracker(ttlMinutesAfterClose = 120) {
  const clock = { now: new Date('2026-10-19T12:00:00Z') };
  const tracker = new CodeTracker({ ttlMinutesAfterClose, now: () => clock.now });
  const advanceMinutes = (m: number): void => {
    clock.now = new Date(clock.now.getTime() + m * 60_000);
  };
  return { tracker, advanceMinutes };
}

describe('CodeTracker.scrubText', () => {
  it('replaces 123456, 123 456 and 123-456 with [sign-in code]', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'aircanada.com', '123456');
    expect(tracker.scrubText('code 123456, or 123 456, or 123-456 done')).toBe(
      `code ${TOKEN}, or ${TOKEN}, or ${TOKEN} done`,
    );
  });

  it('does not touch 1234567 when 123456 is tracked', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'aircanada.com', '123456');
    expect(tracker.scrubText('order 1234567 and x123456 and 1234567')).toBe(
      'order 1234567 and x123456 and 1234567',
    );
  });

  it('does not touch a split form that runs into a longer number', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'aircanada.com', '123456');
    expect(tracker.scrubText('ref 123-4567 and 123 4567')).toBe('ref 123-4567 and 123 4567');
  });

  it('matches alphanumeric codes case-insensitively, including a dash after a prefix', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'example.com', 'g-482913');
    expect(tracker.scrubText('G-482913 / g482913 / G482913 / G 482913')).toBe(
      `${TOKEN} / ${TOKEN} / ${TOKEN} / ${TOKEN}`,
    );
  });

  it('catches a split at any internal position for values of length 6 or more', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'example.com', '12345678');
    expect(tracker.scrubText('1234 5678 | 12-345678 | 1 2345678 | 1234567-8')).toBe(
      `${TOKEN} | ${TOKEN} | ${TOKEN} | ${TOKEN}`,
    );
  });

  it('does not build split variants for 4-5 character values', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'example.com', '4821');
    expect(tracker.scrubText('pin 4821 vs 48 21 vs 48-21')).toBe(`pin ${TOKEN} vs 48 21 vs 48-21`);
  });

  it('replaces every occurrence and covers every tracked value', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'a.com', '111111');
    tracker.register('v2', 'b.com', '222222');
    expect(tracker.scrubText('111111 222222 111111')).toBe(`${TOKEN} ${TOKEN} ${TOKEN}`);
  });

  it('treats a normalized registration the same as the raw form', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'a.com', ' 123 456 ');
    expect(tracker.scrubText('123456')).toBe(TOKEN);
  });

  it('returns text unchanged when nothing is tracked', () => {
    const { tracker } = makeTracker();
    expect(tracker.scrubText('nothing here 123456')).toBe('nothing here 123456');
  });

  it('regex-escapes tracked values instead of interpreting them', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'a.com', 'a.b+c*d');
    expect(tracker.scrubText('axbbbcd and A.B+C*D')).toBe(`axbbbcd and ${TOKEN}`);
  });

  it('ignores an empty registration', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'a.com', '   ');
    expect(tracker.size()).toBe(0);
    expect(tracker.scrubText('some text')).toBe('some text');
  });
});

describe('CodeTracker.scrubDeep', () => {
  it('rewrites nested progress_note and leaves numbers/booleans alone', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'a.com', '123456');
    const input = {
      task_id: 'abc',
      progress_note: 'used 123456 to log in',
      count: 123456,
      flag: true,
      none: null,
      nested: { list: ['x 123 456 y', 42, false, { deep: 'a123456' }] },
    };
    const out = tracker.scrubDeep(input);
    expect(out).toEqual({
      task_id: 'abc',
      progress_note: `used ${TOKEN} to log in`,
      count: 123456,
      flag: true,
      none: null,
      nested: { list: [`x ${TOKEN} y`, 42, false, { deep: 'a123456' }] },
    });
  });

  it('does not mutate the caller object and returns a new structure', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'a.com', '123456');
    const input = { note: 'code 123456', arr: ['123456'] };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    const out = tracker.scrubDeep(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.arr).not.toBe(input.arr);
  });

  it('handles top-level strings, arrays and primitives', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'a.com', '123456');
    expect(tracker.scrubDeep('is 123456')).toBe(`is ${TOKEN}`);
    expect(tracker.scrubDeep(['123456', 7])).toEqual([TOKEN, 7]);
    expect(tracker.scrubDeep(5)).toBe(5);
    expect(tracker.scrubDeep(null)).toBeNull();
    expect(tracker.scrubDeep(undefined)).toBeUndefined();
  });

  it('leaves non-plain objects such as Dates untouched and survives cycles', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'a.com', '123456');
    const when = new Date('2026-10-19T00:00:00Z');
    const cyc: Record<string, unknown> = { note: '123456', when };
    cyc.self = cyc;
    const out = tracker.scrubDeep(cyc);
    expect(out.note).toBe(TOKEN);
    expect(out.when).toBe(when);
    expect(out.self).toBe(out);
  });
});

describe('CodeTracker expiry', () => {
  it('values expire ttlMinutesAfterClose after closed()', () => {
    const { tracker, advanceMinutes } = makeTracker(120);
    tracker.register('v1', 'a.com', '123456');
    // Not closed yet: never expires, however long it takes.
    advanceMinutes(600);
    expect(tracker.scrubText('123456')).toBe(TOKEN);

    tracker.closed('v1');
    advanceMinutes(119);
    expect(tracker.scrubText('123456')).toBe(TOKEN);
    expect(tracker.size()).toBe(1);

    advanceMinutes(1);
    expect(tracker.scrubText('123456')).toBe('123456');
    expect(tracker.allowedDomainsFor('123456')).toBeNull();
    expect(tracker.size()).toBe(0);
  });

  it('closed() on an unknown verification is a no-op and a second close does not extend the clock', () => {
    const { tracker, advanceMinutes } = makeTracker(60);
    tracker.closed('nope');
    expect(tracker.size()).toBe(0);

    tracker.register('v1', 'a.com', '123456');
    tracker.closed('v1');
    advanceMinutes(40);
    tracker.closed('v1');
    advanceMinutes(20);
    expect(tracker.size()).toBe(0);
  });

  it('expires verifications independently', () => {
    const { tracker, advanceMinutes } = makeTracker(60);
    tracker.register('v1', 'a.com', '111111');
    tracker.register('v2', 'b.com', '222222');
    tracker.closed('v1');
    advanceMinutes(61);
    expect(tracker.scrubText('111111 222222')).toBe(`111111 ${TOKEN}`);
  });
});

describe('CodeTracker.allowedDomainsFor', () => {
  it('returns b2clogin.com for a value tracked against it, null for untracked text', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'https://manulife.b2clogin.com/signin', '123456');
    expect(tracker.allowedDomainsFor('123456')).toEqual(new Set(['b2clogin.com']));
    expect(tracker.allowedDomainsFor('654321')).toBeNull();
    expect(tracker.allowedDomainsFor('')).toBeNull();
  });

  it('matches split and case variants, and unions the domains of every matching verification', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'aircanada.com', '123456');
    tracker.register('v2', 'login.example.co.uk', '123456');
    tracker.register('v3', 'other.com', '999999');
    expect(tracker.allowedDomainsFor('123 456')).toEqual(new Set(['aircanada.com', 'example.co.uk']));
  });

  it('does not match inside a longer alphanumeric run', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'aircanada.com', '123456');
    expect(tracker.allowedDomainsFor('1234567')).toBeNull();
  });

  it('falls back to the lowercased input when the domain has no registrable form', () => {
    const { tracker } = makeTracker();
    tracker.register('v1', 'LocalHost', '123456');
    expect(tracker.allowedDomainsFor('123456')).toEqual(new Set(['localhost']));
  });
});
