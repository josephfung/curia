import { describe, it, expect } from 'vitest';
import { meetsMinimumTrust } from './types.js';

describe('meetsMinimumTrust', () => {
  it('returns false for null trust level', () => {
    expect(meetsMinimumTrust(null, 'low')).toBe(false);
  });

  it('ceo meets all trust levels', () => {
    expect(meetsMinimumTrust('ceo', 'ceo')).toBe(true);
    expect(meetsMinimumTrust('ceo', 'high')).toBe(true);
    expect(meetsMinimumTrust('ceo', 'medium')).toBe(true);
    expect(meetsMinimumTrust('ceo', 'low')).toBe(true);
  });

  it('high meets high and below but not ceo', () => {
    expect(meetsMinimumTrust('high', 'ceo')).toBe(false);
    expect(meetsMinimumTrust('high', 'high')).toBe(true);
    expect(meetsMinimumTrust('high', 'medium')).toBe(true);
    expect(meetsMinimumTrust('high', 'low')).toBe(true);
  });

  it('medium meets medium and below', () => {
    expect(meetsMinimumTrust('medium', 'high')).toBe(false);
    expect(meetsMinimumTrust('medium', 'medium')).toBe(true);
    expect(meetsMinimumTrust('medium', 'low')).toBe(true);
  });

  it('low meets only low', () => {
    expect(meetsMinimumTrust('low', 'medium')).toBe(false);
    expect(meetsMinimumTrust('low', 'low')).toBe(true);
  });
});
