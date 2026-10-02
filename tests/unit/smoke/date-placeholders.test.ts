// Relative dates in smoke stub fixtures (#1956).
import { describe, expect, it } from 'vitest';
import { resolveDatePlaceholders } from '../../smoke/date-placeholders.js';

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

  it('takes next-<weekday> as strictly after today', () => {
    expect(resolveDatePlaceholders('{{date:next-wednesday}}', TZ, NOW)).toBe('2026-10-07');
    expect(resolveDatePlaceholders('{{date:next-friday}}', TZ, NOW)).toBe('2026-10-09');
    expect(resolveDatePlaceholders('{{weekday:today+3}}', TZ, NOW)).toBe('Monday');
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
