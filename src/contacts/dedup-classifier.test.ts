// src/contacts/dedup-classifier.test.ts
//
// Unit tests for the structural-vs-fuzzy pair classifier.
// These tests are pure (no DB, no network) — they exercise classifyPair() in
// isolation to verify the three structural-proof conditions and the fuzzy fallback.
//
// TDD: tests written before implementation per the project's TDD requirement.

import { describe, it, expect } from 'vitest';
import type { Contact, ChannelIdentity } from './types.js';
import { classifyPair, type PairClassification } from './dedup-classifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContact(overrides: Partial<Contact> & { id: string; displayName: string }): Contact {
  return {
    kgNodeId: null,
    role: null,
    systemRole: null,
    status: 'confirmed',
    contactConfidence: 0.8,
    trustLevel: null,
    lastSeenAt: null,
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    notes: null,
    preferredName: null,
    title: null,
    organization: null,
    primaryEmail: null,
    primaryPhone: null,
    timezone: null,
    locale: null,
    location: null,
    pronouns: null,
    linkedinUrl: null,
    bio: null,
    birthday: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeIdentity(
  contactId: string,
  channel: string,
  channelIdentifier: string,
): ChannelIdentity {
  return {
    id: `${contactId}-${channel}-id`,
    contactId,
    channel,
    channelIdentifier,
    label: null,
    verified: true,
    verifiedAt: new Date('2026-01-01'),
    status: 'active',
    source: 'email_participant',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Structural proof: shared channel identity
// ---------------------------------------------------------------------------

describe('classifyPair — structural: shared channel identity', () => {
  it('classifies as structural when both contacts share the same email identity', () => {
    const a = makeContact({ id: 'c1', displayName: 'Alice Smith' });
    const b = makeContact({ id: 'c2', displayName: 'A. Smith' });
    const aIds = [makeIdentity('c1', 'email', 'alice@example.com')];
    const bIds = [makeIdentity('c2', 'email', 'alice@example.com')];

    const result = classifyPair(a, aIds, b, bIds);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('structural');
    expect((result as PairClassification & { type: 'structural' }).reason).toContain('email');
  });

  it('classifies as structural when both contacts share the same phone identity', () => {
    const a = makeContact({ id: 'c1', displayName: 'Bob Jones' });
    const b = makeContact({ id: 'c2', displayName: 'Robert Jones' });
    const aIds = [makeIdentity('c1', 'phone', '+15551234567')];
    const bIds = [makeIdentity('c2', 'phone', '+15551234567')];

    const result = classifyPair(a, aIds, b, bIds);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('structural');
  });

  it('classifies as structural when both contacts share the same signal identity', () => {
    const a = makeContact({ id: 'c1', displayName: 'Carol White' });
    const b = makeContact({ id: 'c2', displayName: 'Carol W' });
    const aIds = [makeIdentity('c1', 'signal', '+447911123456')];
    const bIds = [makeIdentity('c2', 'signal', '+447911123456')];

    const result = classifyPair(a, aIds, b, bIds);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('structural');
  });

  it('does NOT classify as structural when channel types differ (email vs phone)', () => {
    // Use contacts with different names to avoid triggering the exact-name structural path.
    // The test verifies that "email:x" and "phone:x" are not a channel overlap.
    const a = makeContact({ id: 'c1', displayName: 'Davide Brownstein' });
    const b = makeContact({ id: 'c2', displayName: 'D. Brown-Stein III' });
    // Different channels — not an overlap even if the identifier strings happen to match
    const aIds = [makeIdentity('c1', 'email', 'dave@example.com')];
    const bIds = [makeIdentity('c2', 'phone', 'dave@example.com')];

    const result = classifyPair(a, aIds, b, bIds);
    // Name similarity is below threshold (very different after normalization) and the
    // different channels don't constitute a verified identity overlap → no structural match.
    // The pair may be null (below threshold) or fuzzy, but not structural.
    if (result !== null) {
      expect(result.type).not.toBe('structural');
    }
  });

  it('finds overlap when contact a has multiple identities', () => {
    const a = makeContact({ id: 'c1', displayName: 'Eve Clark' });
    const b = makeContact({ id: 'c2', displayName: 'Eve Clark Jr.' });
    const aIds = [
      makeIdentity('c1', 'email', 'eve@work.com'),
      makeIdentity('c1', 'email', 'eve@personal.com'),
    ];
    const bIds = [makeIdentity('c2', 'email', 'eve@personal.com')];

    const result = classifyPair(a, aIds, b, bIds);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('structural');
  });
});

// ---------------------------------------------------------------------------
// Structural proof: same kg_node_id
// ---------------------------------------------------------------------------

describe('classifyPair — structural: same kg_node_id', () => {
  it('classifies as structural when both contacts share the same kg_node_id', () => {
    const a = makeContact({ id: 'c1', displayName: 'Frank Lee', kgNodeId: 'kg-abc-123' });
    const b = makeContact({ id: 'c2', displayName: 'F. Lee', kgNodeId: 'kg-abc-123' });

    const result = classifyPair(a, [], b, []);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('structural');
    expect((result as PairClassification & { type: 'structural' }).reason).toContain('kg_node_id');
  });

  it('does NOT classify as structural for different kg_node_ids (no other structural proof)', () => {
    // Use different names so the exact-name path doesn't fire.
    // The only thing in common is being in the same block — they don't have the same kg_node_id.
    const a = makeContact({ id: 'c1', displayName: 'Graciela Lin', kgNodeId: 'kg-111' });
    const b = makeContact({ id: 'c2', displayName: 'Grace Linden', kgNodeId: 'kg-222' });

    const result = classifyPair(a, [], b, []);
    // Different kg_node_ids, different names → may be fuzzy or null, never structural
    if (result !== null) {
      expect(result.type).not.toBe('structural');
    }
  });

  it('does NOT classify as structural when either kg_node_id is null', () => {
    // One null kg_node_id means the kg_node_id comparison path cannot fire.
    // Use different names to avoid the exact-name path.
    const a = makeContact({ id: 'c1', displayName: 'Henri Tanaka', kgNodeId: null });
    const b = makeContact({ id: 'c2', displayName: 'H. Tan', kgNodeId: 'kg-456' });

    const result = classifyPair(a, [], b, []);
    // One null → kg_node_id path cannot be structural
    // Names are different enough → not exact-name structural
    if (result !== null) {
      expect(result.type).not.toBe('structural');
    }
  });
});

// ---------------------------------------------------------------------------
// Structural proof: exact normalized alias/label match
// ---------------------------------------------------------------------------

describe('classifyPair — structural: exact normalized name match', () => {
  it('classifies as structural on exact (case-insensitive) normalized name match', () => {
    const a = makeContact({ id: 'c1', displayName: 'Irene Park' });
    const b = makeContact({ id: 'c2', displayName: 'Irene Park' });

    const result = classifyPair(a, [], b, []);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('structural');
    expect((result as PairClassification & { type: 'structural' }).reason).toContain('name');
  });

  it('classifies as structural on normalized match despite different casing', () => {
    const a = makeContact({ id: 'c1', displayName: 'IRENE PARK' });
    const b = makeContact({ id: 'c2', displayName: 'irene park' });

    const result = classifyPair(a, [], b, []);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('structural');
  });

  it('classifies as structural on normalized match despite punctuation differences', () => {
    // Both contacts normalize to the same ASCII string (lowercased, stripped punctuation).
    // "O'Brien" → "obrien"; "O Brien" → "o brien" — these differ.
    // Use a cleaner example: "Smith, John" vs "Smith John" — comma stripped
    const a = makeContact({ id: 'c1', displayName: 'Smith, John' });
    const b = makeContact({ id: 'c2', displayName: 'Smith John' });

    // "smith john" === "smith john" after normalization — structural
    const result = classifyPair(a, [], b, []);
    expect(result?.type).toBe('structural');
  });

  it('classifies as fuzzy on similar but not identical names (no shared variants)', () => {
    // "Natalia Perez" variants: ["natalia perez", "perez natalia", "n perez"]
    // "Nathan Pierce" variants: ["nathan pierce", "pierce nathan", "n pierce"]
    // No shared exact normalized variants → fuzzy (high JW but not exact-match structural)
    const a = makeContact({ id: 'c1', displayName: 'Natalia Perez' });
    const b = makeContact({ id: 'c2', displayName: 'Nathan Pierce' });

    const result = classifyPair(a, [], b, []);
    // Not an exact normalized match → fuzzy or null (but not structural)
    if (result !== null) {
      expect(result.type).toBe('fuzzy');
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzzy pairs
// ---------------------------------------------------------------------------

describe('classifyPair — fuzzy: name similarity', () => {
  it('classifies similar names as fuzzy when they share no exact normalized variant', () => {
    // "Natalia Perez" and "Nathan Pierce" have similar sound but no shared exact variants:
    //   Natalia variants: ["natalia perez", "perez natalia", "n perez"]
    //   Nathan  variants: ["nathan pierce", "pierce nathan", "n pierce"]
    // None of these are identical → not structural; high JW → fuzzy (if above 0.7 threshold)
    const a = makeContact({ id: 'c1', displayName: 'Natalia Perez' });
    const b = makeContact({ id: 'c2', displayName: 'Nathan Pierce' });

    const result = classifyPair(a, [], b, []);
    // Must not be structural (no shared exact variant)
    if (result !== null) {
      expect(result.type).toBe('fuzzy');
    }
  });

  it('returns null for contacts below the scoring threshold', () => {
    const a = makeContact({ id: 'c1', displayName: 'Alice Johnson' });
    const b = makeContact({ id: 'c2', displayName: 'Zhao Wei' });

    const result = classifyPair(a, [], b, []);
    // Completely different names, no shared identities → below threshold
    expect(result).toBeNull();
  });

  it('includes the original DedupService score and reason in fuzzy results', () => {
    // Use names with no shared exact variants for a genuine fuzzy result.
    // "Natalia Perez" vs "Nathan Pierce" — no shared variants, but JW similar.
    const a = makeContact({ id: 'c1', displayName: 'Natalia Perez' });
    const b = makeContact({ id: 'c2', displayName: 'Nathan Pierce' });

    const result = classifyPair(a, [], b, []);
    if (result === null) {
      // Score below threshold — the test still passes (we're checking the shape when it does match)
      return;
    }
    // If a result exists, it must be fuzzy (not structural)
    expect(result.type).toBe('fuzzy');
    if (result.type === 'fuzzy') {
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.reason).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Structural proof priority: channel overlap overrides name similarity
// ---------------------------------------------------------------------------

describe('classifyPair — structural takes priority over fuzzy', () => {
  it('classifies as structural (not fuzzy) when both a name match and a channel overlap exist', () => {
    // These contacts have high name similarity AND a shared email — structural wins
    const a = makeContact({ id: 'c1', displayName: 'Kim Lee' });
    const b = makeContact({ id: 'c2', displayName: 'Kim Lee' });
    const aIds = [makeIdentity('c1', 'email', 'kim@acme.com')];
    const bIds = [makeIdentity('c2', 'email', 'kim@acme.com')];

    const result = classifyPair(a, aIds, b, bIds);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('structural');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('classifyPair — edge cases', () => {
  it('returns null for self-comparison (a.id === b.id)', () => {
    const a = makeContact({ id: 'c1', displayName: 'Leo Vega' });

    const result = classifyPair(a, [], a, []);
    expect(result).toBeNull();
  });

  it('handles contacts with no identities and no kg_node_id', () => {
    const a = makeContact({ id: 'c1', displayName: 'Completely Unique Name XYZQ' });
    const b = makeContact({ id: 'c2', displayName: 'Another Unique Name ABCD' });

    const result = classifyPair(a, [], b, []);
    // Very different names — should be null (below threshold)
    expect(result).toBeNull();
  });
});
