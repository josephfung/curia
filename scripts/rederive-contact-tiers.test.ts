import { describe, it, expect, vi } from 'vitest';
import { runRederive } from './rederive-contact-tiers.js';
import { JUDGMENT_ELEVATION_THRESHOLD } from '../src/contacts/confidence-scorer.js';

describe('runRederive', () => {
  it('elevates unknown person/org contacts whose recomputed confidence clears the threshold, leaves others', async () => {
    const unknown = [
      { id: 'a', tier: 'unknown', kind: 'person', contactConfidence: 0 },
      { id: 'b', tier: 'unknown', kind: 'organization', contactConfidence: 0 },
    ];
    // After recompute, 'a' clears the threshold, 'b' does not.
    const confidenceById: Record<string, number> = {
      a: JUDGMENT_ELEVATION_THRESHOLD + 0.1,
      b: JUDGMENT_ELEVATION_THRESHOLD - 0.1,
    };
    const pipeline = {
      fullRecomputeAll: vi.fn().mockResolvedValue(undefined),
      fullRecompute: vi.fn((id: string) => Promise.resolve(confidenceById[id] ?? 0)),
    };
    const contactService = {
      listContacts: vi.fn().mockResolvedValue(unknown),
      elevateTierToKnown: vi.fn().mockResolvedValue(true),
    };

    const result = await runRederive(contactService as never, pipeline as never);

    expect(contactService.elevateTierToKnown).toHaveBeenCalledWith('a', 'judgment');
    expect(contactService.elevateTierToKnown).not.toHaveBeenCalledWith('b', 'judgment');
    expect(result.elevated).toBe(1);
  });
});
