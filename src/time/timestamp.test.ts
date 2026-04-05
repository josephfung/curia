import { describe, it, expect } from 'vitest';
import { normalizeTimestamp, describeTimestampInput } from './timestamp.js';

describe('normalizeTimestamp', () => {
  const tz = 'America/Toronto';

  it('passes through a Z-suffix string (already UTC)', () => {
    const result = normalizeTimestamp('2026-04-06T12:00:00Z', tz);
    expect(result).toBe('2026-04-06T12:00:00.000Z');
  });

  it('converts an offset-aware string to UTC', () => {
    // 2026-04-06T08:00:00-04:00 = 12:00 UTC
    const result = normalizeTimestamp('2026-04-06T08:00:00-04:00', tz);
    expect(result).toBe('2026-04-06T12:00:00.000Z');
  });

  it('treats offset-less ISO as Toronto local (EDT = UTC-4 in April)', () => {
    // 2026-04-06T08:00:00 with no offset → Toronto EDT → UTC+4h = 12:00 UTC
    const result = normalizeTimestamp('2026-04-06T08:00:00', tz);
    expect(result).toBe('2026-04-06T12:00:00.000Z');
  });

  it('handles winter correctly (EST = UTC-5)', () => {
    // 2026-01-06T08:00:00 Toronto EST → UTC+5h = 13:00 UTC
    const result = normalizeTimestamp('2026-01-06T08:00:00', tz);
    expect(result).toBe('2026-01-06T13:00:00.000Z');
  });

  it('handles date-only ISO string as local midnight', () => {
    // "2026-04-06" → Toronto EDT midnight → 04:00 UTC
    const result = normalizeTimestamp('2026-04-06', tz);
    expect(result).toBe('2026-04-06T04:00:00.000Z');
  });

  it('handles leading/trailing whitespace', () => {
    const result = normalizeTimestamp('  2026-04-06T08:00:00  ', tz);
    expect(result).toBe('2026-04-06T12:00:00.000Z');
  });

  it('handles offset without colon (e.g. -0400)', () => {
    const result = normalizeTimestamp('2026-04-06T08:00:00-0400', tz);
    expect(result).toBe('2026-04-06T12:00:00.000Z');
  });

  it('throws on invalid input', () => {
    expect(() => normalizeTimestamp('not-a-date', tz)).toThrow('Invalid timestamp');
  });

  it('throws on empty string after trim', () => {
    expect(() => normalizeTimestamp('   ', tz)).toThrow('Invalid timestamp');
  });
});

describe('describeTimestampInput', () => {
  it('includes the default timezone name', () => {
    const desc = describeTimestampInput('America/Toronto');
    expect(desc).toContain('America/Toronto');
  });

  it('says "Curia\'s timezone" not "Nathan\'s timezone"', () => {
    const desc = describeTimestampInput('America/Toronto');
    expect(desc).toContain("Curia's timezone");
    expect(desc).not.toContain("Nathan");
  });

  it('mentions ISO 8601', () => {
    const desc = describeTimestampInput('America/Toronto');
    expect(desc).toContain('ISO 8601');
  });
});
