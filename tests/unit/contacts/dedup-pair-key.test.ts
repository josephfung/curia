import { describe, it, expect } from 'vitest';
import {
  canonicalPairKey,
  dedupPairTag,
  extractPairKeyFromDescription,
  extractPairKeyFromTags,
  pairKeyFromDedupTask,
} from '../../../src/contacts/dedup-pair-key.js';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

describe('dedup-pair-key', () => {
  it('canonicalPairKey is order-independent and lowercase', () => {
    expect(canonicalPairKey(UUID_A, UUID_B)).toBe(`${UUID_A}:${UUID_B}`);
    expect(canonicalPairKey(UUID_B, UUID_A)).toBe(`${UUID_A}:${UUID_B}`);
    expect(canonicalPairKey(UUID_A.toUpperCase(), UUID_B)).toBe(`${UUID_A}:${UUID_B}`);
  });

  it('dedupPairTag encodes the canonical pair key', () => {
    expect(dedupPairTag(UUID_B, UUID_A)).toBe(`dedup-pair:${UUID_A}:${UUID_B}`);
  });

  it('extractPairKeyFromTags reads structured dedup-pair tags', () => {
    expect(extractPairKeyFromTags(['dedup', `dedup-pair:${UUID_B}:${UUID_A}`])).toBe(`${UUID_A}:${UUID_B}`);
  });

  it('extractPairKeyFromDescription parses legacy description lines', () => {
    const description = [
      'Contact A ID: 11111111-1111-1111-1111-111111111111  (Alice)',
      'Contact B ID: 22222222-2222-2222-2222-222222222222  (Bob)',
    ].join('\n');
    expect(extractPairKeyFromDescription(description)).toBe(`${UUID_A}:${UUID_B}`);
  });

  // The 'i' flag on CONTACT_ID_LINE_RE is load-bearing — it is what accepts label
  // casing other than the canonical "Contact A ID:". Nothing pinned that until now
  // (the test above is canonical-cased despite what its name used to claim), so the
  // flag looked droppable as "redundant now that UUID_PATTERN spells both hex
  // cases". It is not: dropping it silently stops parsing these descriptions.
  it('extractPairKeyFromDescription accepts non-canonical label casing', () => {
    const lower = [
      `contact a id: ${UUID_A}  (Alice)`,
      `contact b id: ${UUID_B}  (Bob)`,
    ].join('\n');
    expect(extractPairKeyFromDescription(lower)).toBe(`${UUID_A}:${UUID_B}`);

    const shouty = [
      `CONTACT A ID: ${UUID_A}  (Alice)`,
      `CONTACT B ID: ${UUID_B}  (Bob)`,
    ].join('\n');
    expect(extractPairKeyFromDescription(shouty)).toBe(`${UUID_A}:${UUID_B}`);
  });

  it('extractPairKeyFromDescription accepts uppercase hex in the ids', () => {
    const description = [
      `Contact A ID: ${UUID_A.toUpperCase()}  (Alice)`,
      `Contact B ID: ${UUID_B.toUpperCase()}  (Bob)`,
    ].join('\n');
    expect(extractPairKeyFromDescription(description)).toBe(`${UUID_A}:${UUID_B}`);
  });

  // The converse of the comment on CANONICAL_PAIR_KEY_RE: its 'i' flag does NOT make
  // the tag prefix case-insensitive. extractPairKeyFromTags gates on startsWith,
  // which is case-sensitive, and strips the prefix before the regex sees anything.
  it('extractPairKeyFromTags requires the exact dedup-pair: prefix casing', () => {
    expect(extractPairKeyFromTags([`Dedup-Pair:${UUID_A}:${UUID_B}`])).toBeNull();
    expect(extractPairKeyFromTags([`DEDUP-PAIR:${UUID_A}:${UUID_B}`])).toBeNull();
    expect(extractPairKeyFromTags([`dedup-pair:${UUID_A}:${UUID_B}`])).toBe(`${UUID_A}:${UUID_B}`);
  });

  it('extractPairKeyFromTags accepts uppercase hex after the prefix', () => {
    expect(
      extractPairKeyFromTags([`dedup-pair:${UUID_A.toUpperCase()}:${UUID_B.toUpperCase()}`]),
    ).toBe(`${UUID_A}:${UUID_B}`);
  });

  it('pairKeyFromDedupTask prefers tags over description', () => {
    const task = {
      tags: [`dedup-pair:${UUID_A}:${UUID_B}`],
      description: `Contact A ID: ${UUID_B}\nContact B ID: ${UUID_A}`,
    };
    expect(pairKeyFromDedupTask(task)).toBe(`${UUID_A}:${UUID_B}`);
  });
});
