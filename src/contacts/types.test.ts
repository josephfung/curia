import { describe, it, expect } from 'vitest';
import { meetsMinimumTrust, meetsMinimumTier, TIER_RANK } from './types.js';

describe('meetsMinimumTrust (legacy helper — kept for backward compat)', () => {
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
    expect(meetsMinimumTrust('medium', 'ceo')).toBe(false);
    expect(meetsMinimumTrust('medium', 'high')).toBe(false);
    expect(meetsMinimumTrust('medium', 'medium')).toBe(true);
    expect(meetsMinimumTrust('medium', 'low')).toBe(true);
  });

  it('low meets only low', () => {
    expect(meetsMinimumTrust('low', 'medium')).toBe(false);
    expect(meetsMinimumTrust('low', 'low')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New tier system (issue #945)
// ---------------------------------------------------------------------------

describe('TIER_RANK ordering', () => {
  it('enforces blocked < unknown < known < trusted < principal', () => {
    expect(TIER_RANK['blocked']).toBeLessThan(TIER_RANK['unknown']);
    expect(TIER_RANK['unknown']).toBeLessThan(TIER_RANK['known']);
    expect(TIER_RANK['known']).toBeLessThan(TIER_RANK['trusted']);
    expect(TIER_RANK['trusted']).toBeLessThan(TIER_RANK['principal']);
  });

  it('covers all five tiers', () => {
    const tiers = Object.keys(TIER_RANK);
    expect(tiers).toContain('blocked');
    expect(tiers).toContain('unknown');
    expect(tiers).toContain('known');
    expect(tiers).toContain('trusted');
    expect(tiers).toContain('principal');
  });
});

describe('meetsMinimumTier', () => {
  it('principal meets all tiers', () => {
    expect(meetsMinimumTier('principal', 'principal')).toBe(true);
    expect(meetsMinimumTier('principal', 'trusted')).toBe(true);
    expect(meetsMinimumTier('principal', 'known')).toBe(true);
    expect(meetsMinimumTier('principal', 'unknown')).toBe(true);
    expect(meetsMinimumTier('principal', 'blocked')).toBe(true);
  });

  it('trusted meets trusted and below but not principal', () => {
    expect(meetsMinimumTier('trusted', 'principal')).toBe(false);
    expect(meetsMinimumTier('trusted', 'trusted')).toBe(true);
    expect(meetsMinimumTier('trusted', 'known')).toBe(true);
    expect(meetsMinimumTier('trusted', 'unknown')).toBe(true);
    expect(meetsMinimumTier('trusted', 'blocked')).toBe(true);
  });

  it('known meets known and below but not trusted or principal', () => {
    expect(meetsMinimumTier('known', 'principal')).toBe(false);
    expect(meetsMinimumTier('known', 'trusted')).toBe(false);
    expect(meetsMinimumTier('known', 'known')).toBe(true);
    expect(meetsMinimumTier('known', 'unknown')).toBe(true);
    expect(meetsMinimumTier('known', 'blocked')).toBe(true);
  });

  it('unknown meets unknown and blocked only', () => {
    expect(meetsMinimumTier('unknown', 'principal')).toBe(false);
    expect(meetsMinimumTier('unknown', 'trusted')).toBe(false);
    expect(meetsMinimumTier('unknown', 'known')).toBe(false);
    expect(meetsMinimumTier('unknown', 'unknown')).toBe(true);
    expect(meetsMinimumTier('unknown', 'blocked')).toBe(true);
  });

  it('blocked meets only blocked', () => {
    expect(meetsMinimumTier('blocked', 'principal')).toBe(false);
    expect(meetsMinimumTier('blocked', 'trusted')).toBe(false);
    expect(meetsMinimumTier('blocked', 'known')).toBe(false);
    expect(meetsMinimumTier('blocked', 'unknown')).toBe(false);
    expect(meetsMinimumTier('blocked', 'blocked')).toBe(true);
  });

  it('is consistent with TIER_RANK ordering for all pairs', () => {
    // The helper must be strictly equivalent to rank comparison for every combo.
    const tiers = ['blocked', 'unknown', 'known', 'trusted', 'principal'] as const;
    for (const actual of tiers) {
      for (const required of tiers) {
        const expected = TIER_RANK[actual] >= TIER_RANK[required];
        expect(meetsMinimumTier(actual, required)).toBe(expected);
      }
    }
  });

  it('throws on an unrecognized actual tier value', () => {
    // A silent wrong answer at a trust comparison is worse than an early throw.
    // The TypeScript type system prevents this at compile time, but runtime data
    // from the DB or deserialisation can produce invalid values.
    expect(() => meetsMinimumTier('superadmin' as never, 'known')).toThrow(
      /unrecognized tier value/,
    );
  });

  it('throws on an unrecognized required tier value', () => {
    expect(() => meetsMinimumTier('known', 'superadmin' as never)).toThrow(
      /unrecognized tier value/,
    );
  });

  it('throws when both tier values are unrecognized', () => {
    expect(() => meetsMinimumTier('foo' as never, 'bar' as never)).toThrow(
      /unrecognized tier value/,
    );
  });
});
