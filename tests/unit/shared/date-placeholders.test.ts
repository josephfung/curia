// Relative dates in smoke stub fixtures (#1956).
import { describe, expect, it } from 'vitest';
import { resolveDatePlaceholders } from '../../shared/date-placeholders.js';

// Friday 2026-10-02, 10:00 in Toronto (14:00 UTC).
const NOW = new Date('2026-10-02T14:00:00Z');
const TZ = 'America/Toronto';

describe('resolveDatePlaceholders', () => {
  it('resolves today and offsets as local dates', () => {
    expect(resolveDatePlaceholders('{{date:today}} {{date:today+1}} {{date:today-2}}', TZ, NOW))
      .toBe('2026-10-02 2026-10-03 2026-09-30');
  });

  it('uses the principal\'s day, not UTC\'s', () => {
    // 02:00 UTC on the 3rd is still the 2nd in Toronto.
    expect(resolveDatePlaceholders('{{date:today}}', TZ, new Date('2026-10-03T02:00:00Z'))).toBe('2026-10-02');
  });

  it('takes "today" from dayClock when given, keeping now for {{at:…}}', () => {
    // The turn runs just past midnight; the case's day began on the 2nd.
    const turn = new Date('2026-10-03T04:00:30Z'); // 00:00:30 on the 3rd in Toronto
    const dayClock = new Date('2026-10-03T03:59:59Z'); // 23:59:59 on the 2nd
    expect(resolveDatePlaceholders('{{date:today}} {{at:now}}', TZ, turn, dayClock))
      .toBe('2026-10-02 2026-10-03T00:00:00.000-04:00');
  });

  it('takes next-<weekday> as strictly after today', () => {
    expect(resolveDatePlaceholders('{{date:next-wednesday}}', TZ, NOW)).toBe('2026-10-07');
    expect(resolveDatePlaceholders('{{date:next-friday}}', TZ, NOW)).toBe('2026-10-09');
    expect(resolveDatePlaceholders('{{weekday:today+3}}', TZ, NOW)).toBe('Monday');
  });

  it('counts workday+N in Monday-to-Friday days after today', () => {
    // NOW is a Friday: the next two workdays are Monday and Tuesday.
    expect(resolveDatePlaceholders('{{date:workday+1}} {{date:workday+2}} {{date:workday+6}}', TZ, NOW))
      .toBe('2026-10-05 2026-10-06 2026-10-12');
    // From a Wednesday, the weekend is skipped only once it is reached.
    expect(resolveDatePlaceholders('{{date:workday+2}} {{date:workday+3}}', TZ, new Date('2026-10-07T14:00:00Z')))
      .toBe('2026-10-09 2026-10-12');
    expect(() => resolveDatePlaceholders('{{date:workday+0}}', TZ, NOW)).toThrow(/unknown day 'workday\+0'/);
  });

  it('renders times the way calendar tools return them, with the local offset', () => {
    expect(resolveDatePlaceholders('{{time:next-wednesday 09:30}}', TZ, NOW)).toBe('2026-10-07T09:30:00.000-04:00');
    // After the DST change the offset follows.
    expect(resolveDatePlaceholders('{{time:today+40 09:30}}', TZ, NOW)).toBe('2026-11-11T09:30:00.000-05:00');
  });

  it('walks nested fixtures and leaves other values alone', () => {
    expect(resolveDatePlaceholders({ events: [{ start: '{{time:today 08:00}}', busy: true, n: 1 }] }, TZ, NOW))
      .toEqual({ events: [{ start: '2026-10-02T08:00:00.000-04:00', busy: true, n: 1 }] });
  });

  it('rejects a malformed placeholder', () => {
    expect(() => resolveDatePlaceholders('{{date:tomorrow}}', TZ, NOW)).toThrow(/unknown day 'tomorrow'/);
    expect(() => resolveDatePlaceholders('{{time:today}}', TZ, NOW)).toThrow(/<day> HH:mm/);
    expect(() => resolveDatePlaceholders('{{time:today 25:00}}', TZ, NOW)).toThrow(/invalid time/);
  });
});

describe('prose dates and offsets from a weekday', () => {
  it('renders {{day:…}} for a message', () => {
    expect(resolveDatePlaceholders('due {{day:next-wednesday}}', TZ, NOW)).toBe('due Wednesday, October 7');
  });

  it('adds days to next-<weekday>', () => {
    expect(resolveDatePlaceholders('{{date:next-monday+7}}', TZ, NOW)).toBe('2026-10-12');
  });

  it('resolves {{at:…}} relative to now, to the minute', () => {
    expect(resolveDatePlaceholders('{{at:now+60m}}', TZ, NOW)).toBe('2026-10-02T11:00:00.000-04:00');
    expect(resolveDatePlaceholders('{{at:now-2h}}', TZ, NOW)).toBe('2026-10-02T08:00:00.000-04:00');
    expect(() => resolveDatePlaceholders('{{at:soon}}', TZ, NOW)).toThrow(/now\+Nm/);
  });

  it('fills {{timezone}}', () => {
    expect(resolveDatePlaceholders('{{timezone}}', TZ, NOW)).toBe('America/Toronto');
  });
});
