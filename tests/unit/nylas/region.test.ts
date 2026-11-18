import { describe, it, expect } from 'vitest';
import { nylasApiUri, parseNylasRegion } from '../../../src/nylas/region.js';

describe('nylas region', () => {
  it('maps each region to its API host', () => {
    expect(nylasApiUri('us')).toBe('https://api.us.nylas.com');
    expect(nylasApiUri('eu')).toBe('https://api.eu.nylas.com');
  });

  it('parses case-insensitively', () => {
    expect(parseNylasRegion('EU')).toBe('eu');
    expect(parseNylasRegion(' us ')).toBe('us');
  });

  it('reads blank or absent as us', () => {
    expect(parseNylasRegion('')).toBe('us');
    expect(parseNylasRegion('  ')).toBe('us');
    expect(parseNylasRegion(undefined)).toBe('us');
  });

  it('returns null for an unknown region', () => {
    expect(parseNylasRegion('apac')).toBeNull();
  });
});
