import { describe, it, expect } from 'vitest';
import { isValidTimezone, normalizeTimezone, usableTimezone } from '../../../src/time/timezone-normalize.js';

describe('isValidTimezone', () => {
  it('accepts IANA names and UTC', () => {
    expect(isValidTimezone('America/Toronto')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects display labels and junk', () => {
    expect(isValidTimezone('Eastern Time - Toronto')).toBe(false);
    expect(isValidTimezone('Eastern Time - US & Canada')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('   ')).toBe(false);
  });
});

describe('usableTimezone', () => {
  it('uses the preferred zone when it is valid', () => {
    expect(usableTimezone('Asia/Tokyo', 'America/Toronto')).toEqual({ zone: 'Asia/Tokyo' });
  });

  it('falls back when there is no preferred zone', () => {
    expect(usableTimezone(null, 'America/Toronto')).toEqual({ zone: 'America/Toronto' });
    expect(usableTimezone(undefined, 'America/Toronto')).toEqual({ zone: 'America/Toronto' });
  });

  it('falls back, naming the rejected value, when the preferred zone is invalid', () => {
    expect(usableTimezone('Eastern Time - Toronto', 'UTC')).toEqual({ zone: 'UTC', rejected: 'Eastern Time - Toronto' });
  });
});

describe('normalizeTimezone', () => {
  it('returns a valid IANA name unchanged', () => {
    expect(normalizeTimezone('America/Toronto')).toBe('America/Toronto');
    expect(normalizeTimezone('  Europe/London ')).toBe('Europe/London');
  });

  it('fixes the casing of a valid IANA name', () => {
    expect(normalizeTimezone('america/toronto')).toBe('America/Toronto');
  });

  it('keeps a valid alias as given rather than swapping in its canonical zone', () => {
    // Intl resolves "EST" to America/Panama; silently storing a different zone name
    // than the caller wrote would be more surprising than keeping their valid value.
    expect(normalizeTimezone('EST')).toBe('EST');
  });

  it('maps a Google Calendar "<region> - <city>" label to the city\'s zone', () => {
    expect(normalizeTimezone('Eastern Time - Toronto')).toBe('America/Toronto');
    expect(normalizeTimezone('Pacific Time - Los Angeles')).toBe('America/Los_Angeles');
    expect(normalizeTimezone('Central Time - Mexico City')).toBe('America/Mexico_City');
    expect(normalizeTimezone('Central European Time - Paris')).toBe('Europe/Paris');
  });

  it('accepts en and em dash separators', () => {
    expect(normalizeTimezone('Eastern Time – Toronto')).toBe('America/Toronto');
    expect(normalizeTimezone('Eastern Time — Toronto')).toBe('America/Toronto');
  });

  it('maps a bare city name', () => {
    expect(normalizeTimezone('Toronto')).toBe('America/Toronto');
  });

  it('rejects labels with no identifiable city', () => {
    // Zoom's label: "US & Canada" spans several zones, so there is no safe answer.
    expect(normalizeTimezone('Eastern Time - US & Canada')).toBeNull();
    expect(normalizeTimezone('(GMT-05:00) Eastern Time (US & Canada)')).toBeNull();
    expect(normalizeTimezone('Eastern Time')).toBeNull();
    expect(normalizeTimezone('not a timezone')).toBeNull();
  });

  it('collapses odd whitespace around the separator', () => {
    expect(normalizeTimezone('Eastern Time  -   Toronto')).toBe('America/Toronto');
    expect(normalizeTimezone('Eastern\tTime - Toronto')).toBe('America/Toronto');
  });

  // The console's free-text field takes up to 64 KiB. A long whitespace run with no dash
  // made a `\s+`-led separator backtrack quadratically and block the event loop.
  it('handles a long whitespace run in linear time', () => {
    const hostile = `a${' '.repeat(60_000)}b`;
    const start = performance.now();
    expect(normalizeTimezone(hostile)).toBeNull();
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('rejects empty input', () => {
    expect(normalizeTimezone('')).toBeNull();
    expect(normalizeTimezone('   ')).toBeNull();
  });
});
