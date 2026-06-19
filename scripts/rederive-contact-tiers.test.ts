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
      // Resolves with the total contact count (2), matching fullRecomputeAll's Promise<number> type.
      fullRecomputeAll: vi.fn().mockResolvedValue(2),
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
    // recomputed reflects the total processed by fullRecomputeAll (all contacts, not just candidates)
    expect(result.recomputed).toBe(2);
    // 'b' is below the threshold so it is skipped, not elevated
    expect(result.skipped).toBe(1);
  });
});
