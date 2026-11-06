import { describe, it, expect } from 'vitest';
import {
  canAutoMerge,
  choosePrimary,
  dedupPairFingerprint,
  dedupReviewRoute,
  fingerprintFromTags,
  routeFromTags,
} from '../../../src/contacts/dedup-routing.js';
import type { PairClassification } from '../../../src/contacts/dedup-classifier.js';
import type { ChannelIdentity, Contact, ContactKind, ContactTier } from '../../../src/contacts/types.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function contact(id: string, over: Partial<Contact> = {}): Contact {
  return {
    id, kgNodeId: null, displayName: 'Robert Jones', role: null, notes: null, systemRole: null,
    tier: 'unknown', kind: 'person', createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as Contact;
}

function identity(contactId: string, channelIdentifier: string, verified = true, channel = 'email'): ChannelIdentity {
  return { id: `${contactId}-${channelIdentifier}`, contactId, channel, channelIdentifier, verified } as ChannelIdentity;
}

const byIdentity: PairClassification = { type: 'structural', proof: 'identity', reason: 'Same email identifier' };
const byKgNode: PairClassification = { type: 'structural', proof: 'kg_node', reason: 'Same kg_node_id: n1' };
const byName: PairClassification = { type: 'structural', proof: 'name', reason: 'Exact normalized name match' };
const fuzzy: PairClassification = { type: 'fuzzy', score: 0.95, reason: 'Similar name (0.95)' };

describe('dedupReviewRoute', () => {
  const cases: Array<[ContactKind, ContactTier, ContactKind, ContactTier, 'curia' | 'principal']> = [
    ['person', 'known', 'person', 'unknown', 'principal'],
    ['person', 'unknown', 'person', 'trusted', 'principal'],
    ['person', 'unknown', 'person', 'unknown', 'curia'],
    ['person', 'blocked', 'person', 'unknown', 'curia'],
    ['organization', 'known', 'person', 'known', 'curia'],
    ['automated', 'trusted', 'automated', 'trusted', 'curia'],
    ['person', 'known', 'automated', 'unknown', 'curia'],
    ['principal', 'principal', 'person', 'known', 'curia'],
  ];
  it.each(cases)('%s/%s + %s/%s → %s', (ka, ta, kb, tb, route) => {
    expect(dedupReviewRoute({ kind: ka, tier: ta }, { kind: kb, tier: tb })).toBe(route);
    // Order-independent.
    expect(dedupReviewRoute({ kind: kb, tier: tb }, { kind: ka, tier: ta })).toBe(route);
  });
});

describe('canAutoMerge', () => {
  it('merges identity and kg-node proofs at any tier', () => {
    const known = contact(A, { tier: 'trusted' });
    expect(canAutoMerge(known, contact(B), byIdentity)).toBe(true);
    expect(canAutoMerge(known, contact(B), byKgNode)).toBe(true);
  });

  it('merges a name-only proof only when both sides are tier unknown', () => {
    expect(canAutoMerge(contact(A), contact(B), byName)).toBe(true);
    expect(canAutoMerge(contact(A, { tier: 'known' }), contact(B), byName)).toBe(false);
    expect(canAutoMerge(contact(A), contact(B, { tier: 'trusted' }), byName)).toBe(false);
    expect(canAutoMerge(contact(A, { tier: 'blocked' }), contact(B), byName)).toBe(false);
  });

  it('never merges a fuzzy pair', () => {
    expect(canAutoMerge(contact(A), contact(B), fuzzy)).toBe(false);
  });

  it.each([
    ['principal kind', { kind: 'principal' as const }],
    ['agent kind', { kind: 'agent' as const }],
    ['principal tier', { tier: 'principal' as const }],
    ['system role', { systemRole: 'ceo' as Contact['systemRole'] }],
  ])('never merges a contact with a %s, on either side', (_label, over) => {
    for (const proof of [byIdentity, byKgNode, byName]) {
      expect(canAutoMerge(contact(A, over), contact(B), proof)).toBe(false);
      expect(canAutoMerge(contact(A), contact(B, over), proof)).toBe(false);
    }
  });
});

describe('choosePrimary', () => {
  it('prefers more verified identities, then a role, then the older record', () => {
    const older = contact(A, { createdAt: new Date('2025-01-01T00:00:00Z') });
    const newer = contact(B, { createdAt: new Date('2026-01-01T00:00:00Z') });
    expect(choosePrimary(older, [], newer, [identity(B, 'x@y.com')]).primary.id).toBe(B);
    expect(choosePrimary(older, [identity(A, 'u@y.com', false)], newer, []).primary.id).toBe(A);
    expect(choosePrimary(older, [], { ...newer, role: 'CFO' }, []).primary.id).toBe(B);
    expect(choosePrimary(newer, [], older, []).primary.id).toBe(A);
  });

  it('breaks a full tie on id so the choice is deterministic', () => {
    expect(choosePrimary(contact(B), [], contact(A), []).primary.id).toBe(A);
  });
});

describe('dedupPairFingerprint', () => {
  const a = contact(A, { displayName: 'Robert Jones' });
  const b = contact(B, { displayName: 'Rob Jones' });

  it('is order-independent and ignores email case and identity order', () => {
    const fp = dedupPairFingerprint(a, [identity(A, 'r@x.com'), identity(A, '+15555550100', true, 'sms')], b, []);
    expect(dedupPairFingerprint(b, [], a, [identity(A, '+15555550100', true, 'sms'), identity(A, 'R@X.com')])).toBe(fp);
  });

  it('changes on a name edit or an added identity', () => {
    const fp = dedupPairFingerprint(a, [], b, []);
    expect(dedupPairFingerprint(a, [], { ...b, displayName: 'Robbie Jones' }, [])).not.toBe(fp);
    expect(dedupPairFingerprint(a, [], b, [identity(B, 'rob@x.com')])).not.toBe(fp);
  });
});

describe('tag readers', () => {
  it('read the route and fingerprint back, or null for a pre-#2493 task', () => {
    expect(routeFromTags(['dedup', 'dedup-route:curia'])).toBe('curia');
    expect(routeFromTags(['dedup', 'dedup-route:principal'])).toBe('principal');
    expect(routeFromTags(['dedup'])).toBeNull();
    expect(fingerprintFromTags(['dedup-fp:abc123'])).toBe('abc123');
    expect(fingerprintFromTags(undefined)).toBeNull();
  });
});
