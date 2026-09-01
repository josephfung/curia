// Unit tests for ordered-pair normalization of contact dedup exclusions.
//
// Exclusions are stored one row per unordered pair in contact_dedup_exclusions,
// with a CHECK (contact_a_id < contact_b_id). Normalization is the single
// chokepoint that guarantees callers can pass a pair in either order and casing
// and still hit (or create) the same row. See ADR-039.

import { describe, it, expect } from 'vitest';
import {
  normalizeExclusionPair,
  InvalidExclusionPairError,
} from './dedup-exclusions.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('normalizeExclusionPair', () => {
  it('orders the pair ascending regardless of argument order', () => {
    expect(normalizeExclusionPair(A, B)).toEqual({ contactAId: A, contactBId: B });
    expect(normalizeExclusionPair(B, A)).toEqual({ contactAId: A, contactBId: B });
  });

  it('lowercases both IDs so casing never splits a pair into two rows', () => {
    // The UUID validators elsewhere accept uppercase; Postgres always returns lowercase.
    expect(normalizeExclusionPair(A.toUpperCase(), B.toUpperCase())).toEqual({
      contactAId: A,
      contactBId: B,
    });
  });

  it('rejects a self-pair (same contact on both sides)', () => {
    expect(() => normalizeExclusionPair(A, A)).toThrow(InvalidExclusionPairError);
  });

  it('rejects a self-pair that differs only by casing', () => {
    expect(() => normalizeExclusionPair(A, A.toUpperCase())).toThrow(InvalidExclusionPairError);
  });

  it('rejects values that are not UUIDs before they reach SQL', () => {
    expect(() => normalizeExclusionPair('not-a-uuid', B)).toThrow(InvalidExclusionPairError);
    expect(() => normalizeExclusionPair(A, '')).toThrow(InvalidExclusionPairError);
  });
});
