import { describe, it, expect } from 'vitest';
import { DedupService } from '../../../src/contacts/dedup-service.js';
import type { Contact, ChannelIdentity } from '../../../src/contacts/types.js';

// Helpers to build minimal Contact and ChannelIdentity fixtures
function makeContact(overrides: Partial<Contact> & { id: string; displayName: string }): Contact {
  return {
    kgNodeId: null,
    role: null,
    status: 'confirmed',
    notes: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeIdentity(
  contactId: string,
  channel: string,
  channelIdentifier: string,
): ChannelIdentity {
  return {
    id: `id-${channel}-${channelIdentifier}`,
    contactId,
    channel,
    channelIdentifier,
    label: null,
    verified: true,
    verifiedAt: null,
    source: 'ceo_stated',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

describe('DedupService', () => {
  const svc = new DedupService();

  describe('checkForDuplicates', () => {
    it('returns certain match when contacts share an email identity', () => {
      const a = makeContact({ id: 'a', displayName: 'Alice Smith' });
      const b = makeContact({ id: 'b', displayName: 'Alice Smyth' });
      const aIdentities = [makeIdentity('a', 'email', 'alice@acme.com')];
      const bIdentities = [makeIdentity('b', 'email', 'alice@acme.com')];
      const identitiesMap = new Map([['b', bIdentities]]);

      const results = svc.checkForDuplicates(a, aIdentities, [b], identitiesMap);
      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe('certain');
      expect(results[0].score).toBe(1);
      expect(results[0].reason).toContain('email');
    });

    it('returns certain match for high Jaro-Winkler name similarity', () => {
      const a = makeContact({ id: 'a', displayName: 'Jennifer Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jennifer Torres' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe('certain');
    });

    it('returns probable match for similar but not identical names', () => {
      const a = makeContact({ id: 'a', displayName: 'Jenna Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jen Torres' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      // "Jenna Torres" vs "Jen Torres" — close enough to be probable or certain
      // The exact score depends on Jaro-Winkler; just ensure we detect them
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].score).toBeGreaterThan(0.7);
    });

    it('detects certain match for contacts with same email but different blocking groups', () => {
      const a = makeContact({ id: 'a', displayName: 'Alice Smith' });
      const b = makeContact({ id: 'b', displayName: 'Robert Jones' }); // "rob" block, not "ali"
      const aIdentities = [makeIdentity('a', 'email', 'shared@acme.com')];
      const bIdentities = [makeIdentity('b', 'email', 'shared@acme.com')];
      const identitiesMap = new Map([['b', bIdentities]]);

      const results = svc.checkForDuplicates(a, aIdentities, [b], identitiesMap);
      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe('certain');
      expect(results[0].score).toBe(1);
    });

    it('matches "J. Torres" against "Jenna Torres" via initial variant', () => {
      const a = makeContact({ id: 'a', displayName: 'J. Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jenna Torres' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      // variant "j torres" vs "jenna torres" or "j torres" should score > 0.7
      expect(results.some(r => r.score >= 0.7)).toBe(true);
    });

    it('ignores pairs with score below 0.7', () => {
      const a = makeContact({ id: 'a', displayName: 'Alice Smith' });
      const b = makeContact({ id: 'b', displayName: 'Bob Jones' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      expect(results).toHaveLength(0);
    });

    it('skips comparison when contacts are in different blocking groups', () => {
      // "alice" (block "ali") vs "xavier" (block "xav") — never compared
      const a = makeContact({ id: 'a', displayName: 'Alice White' });
      const b = makeContact({ id: 'b', displayName: 'Xavier Black' });
      const results = svc.checkForDuplicates(a, [], [b], new Map());
      expect(results).toHaveLength(0);
    });

    it('does not compare a contact against itself', () => {
      const a = makeContact({ id: 'a', displayName: 'Jenna Torres' });
      const results = svc.checkForDuplicates(a, [], [a], new Map());
      expect(results).toHaveLength(0);
    });
  });

  describe('findAllDuplicates', () => {
    it('finds duplicate pair in a list of contacts', () => {
      const a = makeContact({ id: 'a', displayName: 'Jenna Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jenna Torres' });
      const c = makeContact({ id: 'c', displayName: 'Xavier Black' });
      const pairs = svc.findAllDuplicates([a, b, c], new Map());
      expect(pairs.some(p =>
        (p.contactA.id === 'a' && p.contactB.id === 'b') ||
        (p.contactA.id === 'b' && p.contactB.id === 'a')
      )).toBe(true);
    });

    it('respects minConfidence filter', () => {
      const a = makeContact({ id: 'a', displayName: 'Jenna Torres' });
      const b = makeContact({ id: 'b', displayName: 'Jenna Torres' });
      const identitiesMap = new Map([
        ['a', [makeIdentity('a', 'email', 'jenna@acme.com')]],
        ['b', [makeIdentity('b', 'email', 'jenna@acme.com')]],
      ]);
      const allPairs = svc.findAllDuplicates([a, b], identitiesMap, 'probable');
      const certainOnly = svc.findAllDuplicates([a, b], identitiesMap, 'certain');
      expect(certainOnly.length).toBeLessThanOrEqual(allPairs.length);
      expect(certainOnly.every(p => p.confidence === 'certain')).toBe(true);
    });

    it('returns empty list when there are no contacts', () => {
      const pairs = svc.findAllDuplicates([], new Map());
      expect(pairs).toHaveLength(0);
    });

    it('returns empty list when there is only one contact', () => {
      const a = makeContact({ id: 'a', displayName: 'Alice White' });
      const pairs = svc.findAllDuplicates([a], new Map());
      expect(pairs).toHaveLength(0);
    });

    it('returns empty list when all contacts are in different blocking groups', () => {
      const contacts = [
        makeContact({ id: 'a', displayName: 'Alice White' }),
        makeContact({ id: 'b', displayName: 'Bob Jones' }),
        makeContact({ id: 'c', displayName: 'Xavier Black' }),
      ];
      const pairs = svc.findAllDuplicates(contacts, new Map());
      expect(pairs).toHaveLength(0);
    });
  });
});
