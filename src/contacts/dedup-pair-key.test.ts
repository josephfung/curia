import { describe, it, expect } from 'vitest';
import {
  canonicalPairKey,
  dedupPairTag,
  extractPairKeyFromDescription,
  extractPairKeyFromTags,
  pairKeyFromDedupTask,
} from './dedup-pair-key.js';

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

  it('extractPairKeyFromDescription parses legacy description lines case-insensitively', () => {
    const description = [
      'Contact A ID: 11111111-1111-1111-1111-111111111111  (Alice)',
      'Contact B ID: 22222222-2222-2222-2222-222222222222  (Bob)',
    ].join('\n');
    expect(extractPairKeyFromDescription(description)).toBe(`${UUID_A}:${UUID_B}`);
  });

  it('pairKeyFromDedupTask prefers tags over description', () => {
    const task = {
      tags: [`dedup-pair:${UUID_A}:${UUID_B}`],
      description: `Contact A ID: ${UUID_B}\nContact B ID: ${UUID_A}`,
    };
    expect(pairKeyFromDedupTask(task)).toBe(`${UUID_A}:${UUID_B}`);
  });
});
