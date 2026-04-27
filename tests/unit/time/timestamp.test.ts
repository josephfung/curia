import { describe, it, expect } from 'vitest';
import { toLocalIso, formatDisplayTimezone } from '../../../src/time/timestamp.js';

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
