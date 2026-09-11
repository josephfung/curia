import { describe, it, expect } from 'vitest';
import { toLocalIso, formatDisplayTimezone, isPlausibleUnixSeconds, repairQueriedUnixRange, MAX_PLAUSIBLE_UNIX_SECONDS } from '../../../src/time/timestamp.js';

describe('isPlausibleUnixSeconds', () => {
  it('accepts finite timestamps after the Unix epoch', () => {
    expect(isPlausibleUnixSeconds(1)).toBe(true);
    expect(isPlausibleUnixSeconds(1775489400)).toBe(true);
  });

  it('rejects epoch-zero, negatives, non-finite, and millisecond-scale values', () => {
    expect(isPlausibleUnixSeconds(0)).toBe(false);
    expect(isPlausibleUnixSeconds(-1)).toBe(false);
    expect(isPlausibleUnixSeconds(Number.NaN)).toBe(false);
    expect(isPlausibleUnixSeconds(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPlausibleUnixSeconds(1_775_480_400_000)).toBe(false);
    expect(isPlausibleUnixSeconds(MAX_PLAUSIBLE_UNIX_SECONDS + 1)).toBe(false);
  });

  it('accepts the 2100-01-01 inclusive ceiling', () => {
    expect(isPlausibleUnixSeconds(MAX_PLAUSIBLE_UNIX_SECONDS)).toBe(true);
  });
});

describe('repairQueriedUnixRange', () => {
  const rangeStart = 1_775_476_800; // 2026-04-06T12:00:00Z
  const rangeEnd = 1_775_491_200;   // 2026-04-06T16:00:00Z
  const slotEnd = 1_775_480_400;    // 2026-04-06T13:00:00Z
  const slotStart = 1_775_478_600;  // 2026-04-06T12:30:00Z

  it('passes through a fully plausible slot', () => {
    expect(repairQueriedUnixRange(slotStart, slotEnd, rangeStart, rangeEnd)).toEqual({
      start: slotStart,
      end: slotEnd,
    });
  });

  it('clamps a corrupt start to rangeStart when end is usable', () => {
    expect(repairQueriedUnixRange(0, slotEnd, rangeStart, rangeEnd)).toEqual({
      start: rangeStart,
      end: slotEnd,
    });
  });

  it('clamps a corrupt end to rangeEnd when start is usable', () => {
    expect(repairQueriedUnixRange(slotStart, Number.NaN, rangeStart, rangeEnd)).toEqual({
      start: slotStart,
      end: rangeEnd,
    });
  });

  it('returns null when neither endpoint is usable', () => {
    expect(repairQueriedUnixRange(0, -1, rangeStart, rangeEnd)).toBeNull();
    expect(repairQueriedUnixRange(1_775_480_400_000, 1_775_484_000_000, rangeStart, rangeEnd)).toBeNull();
  });

  it('returns null when clamping produces an empty range', () => {
    // end is before rangeStart, so clamping start to rangeStart inverts the slot
    expect(repairQueriedUnixRange(0, rangeStart - 60, rangeStart, rangeEnd)).toBeNull();
  });
});

describe('toLocalIso', () => {
  it('converts Unix seconds to local ISO with offset for America/Toronto in EDT', () => {
    // 1775489400 = 2026-04-06T15:30:00Z = 2026-04-06T11:30:00 EDT (UTC-4)
    expect(toLocalIso(1775489400, 'America/Toronto')).toBe('2026-04-06T11:30:00.000-04:00');
  });

  it('converts Unix seconds to local ISO with offset for America/Toronto in EST', () => {
    // 1738348200 = 2025-01-31T18:30:00Z = 2025-01-31T13:30:00 EST (UTC-5)
    expect(toLocalIso(1738348200, 'America/Toronto')).toBe('2025-01-31T13:30:00.000-05:00');
  });

  it('handles UTC timezone', () => {
    // luxon emits 'Z' suffix for UTC (not +00:00)
    expect(toLocalIso(1775489400, 'UTC')).toBe('2026-04-06T15:30:00.000Z');
  });

  it('handles non-hour-aligned timezone offsets', () => {
    // Asia/Kolkata is UTC+05:30
    // 1775489400 = 2026-04-06T15:30:00Z = 2026-04-06T21:00:00+05:30
    expect(toLocalIso(1775489400, 'Asia/Kolkata')).toBe('2026-04-06T21:00:00.000+05:30');
  });

  it('throws on invalid timezone', () => {
    expect(() => toLocalIso(1775489400, 'Not/A/Zone')).toThrow('invalid timezone');
  });

  it('returns null for null input', () => {
    expect(toLocalIso(null, 'America/Toronto')).toBeNull();
  });

  it('returns null for non-finite input', () => {
    expect(toLocalIso(NaN, 'America/Toronto')).toBeNull();
    expect(toLocalIso(Infinity, 'America/Toronto')).toBeNull();
  });

  it('returns null for non-positive input', () => {
    expect(toLocalIso(0, 'America/Toronto')).toBeNull();
    expect(toLocalIso(-1, 'America/Toronto')).toBeNull();
  });

  it('returns null for millisecond-scale input', () => {
    expect(toLocalIso(1_775_489_400_000, 'America/Toronto')).toBeNull();
  });

  it('falls back to UTC when timezone is omitted', () => {
    // 1775489400 = 2026-04-06T15:30:00Z
    expect(toLocalIso(1775489400)).toBe('2026-04-06T15:30:00.000Z');
  });
});

describe('formatDisplayTimezone', () => {
  it('formats EDT timezone label', () => {
    // April 2026 — EDT is active
    const label = formatDisplayTimezone('America/Toronto', new Date('2026-04-06T15:30:00Z'));
    expect(label).toContain('EDT');
    expect(label).toContain('UTC-04:00');
  });

  it('formats EST timezone label', () => {
    // January 2025 — EST is active
    const label = formatDisplayTimezone('America/Toronto', new Date('2025-01-31T18:30:00Z'));
    expect(label).toContain('EST');
    expect(label).toContain('UTC-05:00');
  });

  it('formats UTC timezone label', () => {
    const label = formatDisplayTimezone('UTC', new Date('2026-04-06T15:30:00Z'));
    expect(label).toBe('UTC');
  });

  it('handles zones without a named abbreviation', () => {
    // Asia/Kolkata has no DST; luxon's ZZZZ returns "GMT+5:30" (not a named abbr).
    // The dedup guard doesn't catch this format, so the output includes both.
    // Mildly redundant but not incorrect — only matters if Curia is deployed
    // in a zone without a standard abbreviation.
    const label = formatDisplayTimezone('Asia/Kolkata', new Date('2026-04-06T15:30:00Z'));
    expect(label).toBe('GMT+5:30 (UTC+05:30)');
  });

  it('throws on invalid timezone', () => {
    expect(() => formatDisplayTimezone('Not/A/Zone', new Date())).toThrow('invalid timezone');
  });
});
