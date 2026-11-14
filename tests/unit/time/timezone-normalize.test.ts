import { describe, it, expect } from 'vitest';
import { isValidTimezone, normalizeTimezone } from '../../../src/time/timezone-normalize.js';

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

  it('rejects empty input', () => {
    expect(normalizeTimezone('')).toBeNull();
    expect(normalizeTimezone('   ')).toBeNull();
  });
});
