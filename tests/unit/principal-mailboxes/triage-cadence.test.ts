import { describe, it, expect, vi } from 'vitest';
import { DateTime } from 'luxon';
import {
  parseCadence,
  readTriageCadences,
  isDue,
  DEFAULT_CADENCE,
  TRIAGE_DAILY_CEILING,
  BACKLOG_ALARM_THRESHOLD,
} from '../../../src/principal-mailboxes/triage-cadence.js';

const TZ = 'America/Toronto';
const at = (iso: string) => new Date(iso);

describe('constants', () => {
  it('has the binding defaults', () => {
    expect(DEFAULT_CADENCE).toBe('hourly 06:00-23:00');
    expect(TRIAGE_DAILY_CEILING).toBe(120);
    expect(BACKLOG_ALARM_THRESHOLD).toBe(100);
  });
});

describe('parseCadence', () => {
  it.each([
    ['hourly', { every: { minutes: 60 } }],
    ['hourly 06:00-23:00', { every: { minutes: 60 }, window: { start: '06:00', end: '23:00' } }],
    ['every 15m', { every: { minutes: 15 } }],
    ['every 30m', { every: { minutes: 30 } }],
    ['every 45m', { every: { minutes: 45 } }],
    ['every 2h', { every: { minutes: 120 } }],
    ['every 24h', { every: { minutes: 1440 } }],
    ['every 30m 07:00-19:00 weekdays', { every: { minutes: 30 }, window: { start: '07:00', end: '19:00' }, weekdaysOnly: true }],
    ['daily 18:00', { every: { dailyAt: '18:00' } }],
    ['daily 18:00 weekdays', { every: { dailyAt: '18:00' }, weekdaysOnly: true }],
    ['  Hourly   06:00-23:00  ', { every: { minutes: 60 }, window: { start: '06:00', end: '23:00' } }],
    // A window that crosses midnight is supported.
    ['hourly 22:00-02:00', { every: { minutes: 60 }, window: { start: '22:00', end: '02:00' } }],
  ])('parses %j', (input, expected) => {
    expect(parseCadence(input)).toEqual(expected);
  });

  it.each([
    '', 'every 10m', 'every 0m', 'every 5m', 'every 20m', 'every 0h', 'every 25h', 'every h',
    'daily', 'daily 25:00', 'daily 18:60', 'daily 6:00', 'hourly 25:00-26:00', 'hourly 06:00',
    'hourly 06:00-24:00', 'hourly 08:00-08:00', 'hourly weekdays 06:00-23:00', 'weekly', 'hourly extra',
    'every 15m weekdays weekdays', 'every -15m', 'every 1.5h',
  ])('rejects %j', (input) => {
    expect(parseCadence(input)).toBeNull();
  });
});

describe('readTriageCadences', () => {
  const dflt = parseCadence(DEFAULT_CADENCE)!;
  const quiet = () => ({ warn: vi.fn() });

  it('defaults every mailbox when nothing is stored', () => {
    expect(readTriageCadences(null, ['work', 'home'], quiet() as never)).toEqual({ work: dflt, home: dflt });
  });

  it('uses stored cadences and defaults unknown ids and invalid values', () => {
    const logger = quiet();
    const raw = JSON.stringify({ work: 'every 30m', home: 'every 10m', gone: 'daily 18:00' });
    const out = readTriageCadences(raw, ['work', 'home', 'extra'], logger as never);
    expect(out).toEqual({ work: parseCadence('every 30m'), home: dflt, extra: dflt });
    expect(Object.keys(out).sort()).toEqual(['extra', 'home', 'work']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('defaults everything on unparseable or non-object JSON', () => {
    for (const raw of ['not json', '[]', '"x"', '5']) {
      expect(readTriageCadences(raw, ['work'], quiet() as never)).toEqual({ work: dflt });
    }
  });

  it('logs an invalid cadence once, not on every tick', () => {
    const logger = quiet();
    const raw = JSON.stringify({ badbox: 'every 10m' });
    readTriageCadences(raw, ['badbox'], logger as never);
    readTriageCadences(raw, ['badbox'], logger as never);
    readTriageCadences(raw, ['badbox'], logger as never);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('isDue', () => {
  const hourly = parseCadence('hourly 06:00-23:00')!;

  it('is not due outside the window', () => {
    // 04:00 EDT on 2026-06-10
    expect(isDue(hourly, null, at('2026-06-10T08:00:00Z'), TZ)).toBe(false);
    // 23:30 EDT
    expect(isDue(hourly, null, at('2026-06-11T03:30:00Z'), TZ)).toBe(false);
  });

  it('is due inside the window once the interval has elapsed', () => {
    const now = at('2026-06-10T14:00:00Z'); // 10:00 EDT
    expect(isDue(hourly, at('2026-06-10T12:59:00Z'), now, TZ)).toBe(true);
    expect(isDue(hourly, at('2026-06-10T13:30:00Z'), now, TZ)).toBe(false);
  });

  it('is due when never drained (inside the window)', () => {
    expect(isDue(hourly, null, at('2026-06-10T14:00:00Z'), TZ)).toBe(true);
  });

  it('treats the window as inclusive of both ends', () => {
    expect(isDue(hourly, null, at('2026-06-10T10:00:00Z'), TZ)).toBe(true); // 06:00 EDT
    expect(isDue(hourly, null, at('2026-06-11T03:00:00Z'), TZ)).toBe(true); // 23:00 EDT
  });

  it('daily: before the time false, after true, second time the same day false', () => {
    const daily = parseCadence('daily 18:00')!;
    expect(isDue(daily, null, at('2026-06-10T21:59:00Z'), TZ)).toBe(false); // 17:59 EDT
    expect(isDue(daily, null, at('2026-06-10T22:00:00Z'), TZ)).toBe(true); // 18:00 EDT
    expect(isDue(daily, at('2026-06-09T22:05:00Z'), at('2026-06-10T22:15:00Z'), TZ)).toBe(true);
    expect(isDue(daily, at('2026-06-10T22:05:00Z'), at('2026-06-10T23:30:00Z'), TZ)).toBe(false);
  });

  it('daily: a drain earlier the same day, before the time, does not use up the slot', () => {
    const daily = parseCadence('daily 18:00')!;
    expect(isDue(daily, at('2026-06-10T14:00:00Z'), at('2026-06-10T22:00:00Z'), TZ)).toBe(true);
  });

  it('weekdays only: Saturday false, Friday true', () => {
    const c = parseCadence('hourly 06:00-23:00 weekdays')!;
    expect(isDue(c, null, at('2026-06-13T15:00:00Z'), TZ)).toBe(false); // Sat
    expect(isDue(c, null, at('2026-06-12T15:00:00Z'), TZ)).toBe(true); // Fri
    expect(isDue(c, null, at('2026-06-14T15:00:00Z'), TZ)).toBe(false); // Sun
  });

  it('weekdays uses the local day, not UTC', () => {
    const c = parseCadence('every 15m weekdays')!;
    // Friday 22:00 EDT is Saturday 02:00Z: still a weekday locally
    expect(isDue(c, null, at('2026-06-13T02:00:00Z'), TZ)).toBe(true);
    // Sunday 21:00 EDT is Monday 01:00Z: still the weekend locally
    expect(isDue(c, null, at('2026-06-15T01:00:00Z'), TZ)).toBe(false);
  });

  it('window crossing midnight: inside both sides, outside the middle', () => {
    const c = parseCadence('hourly 22:00-02:00')!;
    expect(isDue(c, null, at('2026-06-11T02:30:00Z'), TZ)).toBe(true); // 22:30 EDT
    expect(isDue(c, null, at('2026-06-11T05:00:00Z'), TZ)).toBe(true); // 01:00 EDT
    expect(isDue(c, null, at('2026-06-11T14:00:00Z'), TZ)).toBe(false); // 10:00 EDT
  });

  describe('DST in America/Toronto', () => {
    it('spring forward: elapsed time is real time, not wall-clock difference', () => {
      // 01:30 EST (06:30Z) to 03:30 EDT (07:30Z) is one real hour
      expect(isDue(hourly, at('2026-03-08T06:30:00Z'), at('2026-03-08T07:30:00Z'), TZ)).toBe(false); // outside window (03:30)
      const all = parseCadence('hourly')!;
      expect(isDue(all, at('2026-03-08T06:30:00Z'), at('2026-03-08T07:30:00Z'), TZ)).toBe(true);
      expect(isDue(all, at('2026-03-08T06:30:00Z'), at('2026-03-08T07:20:00Z'), TZ)).toBe(false); // 50m real time
    });

    it('window start is 06:00 local on both sides of the change', () => {
      // Day before (EST, UTC-5): 06:00 = 11:00Z. Day of (EDT, UTC-4): 06:00 = 10:00Z.
      expect(isDue(hourly, null, at('2026-03-07T10:59:00Z'), TZ)).toBe(false); // 05:59 EST
      expect(isDue(hourly, null, at('2026-03-07T11:00:00Z'), TZ)).toBe(true);
      expect(isDue(hourly, null, at('2026-03-08T09:59:00Z'), TZ)).toBe(false); // 05:59 EDT
      expect(isDue(hourly, null, at('2026-03-08T10:00:00Z'), TZ)).toBe(true);
    });

    it('daily 18:00 fires at 18:00 local on the spring-forward and fall-back days', () => {
      const daily = parseCadence('daily 18:00')!;
      expect(isDue(daily, null, at('2026-03-08T21:59:00Z'), TZ)).toBe(false); // 17:59 EDT
      expect(isDue(daily, null, at('2026-03-08T22:00:00Z'), TZ)).toBe(true);
      // fall back 2026-11-01, EST afterwards: 18:00 = 23:00Z
      expect(isDue(daily, null, at('2026-11-01T22:59:00Z'), TZ)).toBe(false);
      expect(isDue(daily, null, at('2026-11-01T23:00:00Z'), TZ)).toBe(true);
    });
  });
});

describe('fix round 1', () => {
  // Replay 15-minute real-time ticks across a whole local day, marking a drain on each fire.
  function replay(cadence: string, localDate: string): number {
    const c = parseCadence(cadence)!;
    const start = DateTime.fromISO(localDate, { zone: TZ }).startOf('day').toMillis();
    const end = DateTime.fromISO(localDate, { zone: TZ }).plus({ days: 1 }).startOf('day').toMillis();
    let last: Date | null = null;
    let fires = 0;
    for (let t = start; t < end; t += 15 * 60_000) {
      const now = new Date(t);
      if (isDue(c, last, now, TZ)) {
        fires += 1;
        last = now;
      }
    }
    return fires;
  }

  it('daily 01:30 fires exactly once on the fall-back day (01:30 happens twice)', () => {
    expect(replay('daily 01:30', '2026-11-01')).toBe(1);
  });
  it('daily 02:30 fires exactly once on the spring-forward day (02:30 does not exist)', () => {
    expect(replay('daily 02:30', '2026-03-08')).toBe(1);
  });
  it('daily 18:00 fires once on an ordinary day', () => {
    expect(replay('daily 18:00', '2026-06-10')).toBe(1);
  });

  it('R50: an hourly drain marked seconds after a tick is due at the next hourly tick', () => {
    const c = parseCadence('hourly')!;
    expect(isDue(c, at('2026-06-10T10:00:05Z'), at('2026-06-10T11:00:00Z'), TZ)).toBe(true);
    expect(isDue(c, at('2026-06-10T10:00:05Z'), at('2026-06-10T10:52:00Z'), TZ)).toBe(false);
  });
  it('R50: hourly turns due exactly at 52.5 minutes (every - 7m30s), not a millisecond before (P8)', () => {
    const c = parseCadence('hourly')!;
    const drained = at('2026-06-10T10:00:00Z');
    expect(isDue(c, drained, at('2026-06-10T10:52:29.999Z'), TZ)).toBe(false);
    expect(isDue(c, drained, at('2026-06-10T10:52:30Z'), TZ)).toBe(true);
  });
  it('R50: every 15m is not due 8 minutes after a drain, but is at 15', () => {
    const c = parseCadence('every 15m')!;
    expect(isDue(c, at('2026-06-10T10:00:00Z'), at('2026-06-10T10:08:00Z'), TZ)).toBe(false);
    expect(isDue(c, at('2026-06-10T10:00:00Z'), at('2026-06-10T10:07:30Z'), TZ)).toBe(false);
    expect(isDue(c, at('2026-06-10T10:00:05Z'), at('2026-06-10T10:15:00Z'), TZ)).toBe(true);
  });

  it('R51: weekdays with a midnight-crossing window follows the window-start day', () => {
    const c = parseCadence('hourly 22:00-02:00 weekdays')!;
    expect(isDue(c, null, at('2026-06-13T05:00:00Z'), TZ)).toBe(true); // Sat 01:00 EDT (Friday night)
    expect(isDue(c, null, at('2026-06-15T05:00:00Z'), TZ)).toBe(false); // Mon 01:00 EDT (Sunday night)
    expect(isDue(c, null, at('2026-06-13T02:30:00Z'), TZ)).toBe(true); // Fri 22:30 EDT
    expect(isDue(c, null, at('2026-06-14T02:30:00Z'), TZ)).toBe(false); // Sat 22:30 EDT
  });

  it('a last drain in the future is treated as never drained', () => {
    const hourly = parseCadence('hourly')!;
    const daily = parseCadence('daily 18:00')!;
    expect(isDue(hourly, at('2099-01-01T00:00:00Z'), at('2026-06-10T14:00:00Z'), TZ)).toBe(true);
    expect(isDue(daily, at('2099-01-01T00:00:00Z'), at('2026-06-10T22:00:00Z'), TZ)).toBe(true);
  });

  it('warnOnce does not remember a key when there is no logger', () => {
    const raw = JSON.stringify({ nolog: 'every 10m' });
    readTriageCadences(raw, ['nolog']);
    const logger = { warn: vi.fn() };
    readTriageCadences(raw, ['nolog'], logger as never);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
