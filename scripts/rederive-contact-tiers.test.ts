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
      // Resolves with { recomputed, failed }, matching fullRecomputeAll's return shape.
      fullRecomputeAll: vi.fn().mockResolvedValue({ recomputed: 2, failed: 0 }),
      fullRecompute: vi.fn((id: string) => Promise.resolve(confidenceById[id] ?? 0)),
    };
    const contactService = {
      listContacts: vi.fn().mockResolvedValue(unknown),
      elevateTierToKnown: vi.fn().mockResolvedValue(true),
      getContact: vi.fn(),
    };

    const result = await runRederive(contactService as never, pipeline as never);

    expect(contactService.elevateTierToKnown).toHaveBeenCalledWith('a', 'judgment');
    expect(contactService.elevateTierToKnown).not.toHaveBeenCalledWith('b', 'judgment');
    expect(result.elevated).toBe(1);
    // recomputed reflects the total processed by fullRecomputeAll (all contacts, not just candidates)
    expect(result.recomputed).toBe(2);
    // 'b' is below the threshold so it is skipped, not elevated
    expect(result.skipped).toBe(1);
    // elevateTierToKnown returned true, so no disambiguating re-read is needed
    expect(contactService.getContact).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
  });

  it('counts a masked elevation failure as an error when the contact is still unknown after a false return', async () => {
    const unknown = [{ id: 'a', tier: 'unknown', kind: 'person', contactConfidence: 0 }];
    const pipeline = {
      fullRecomputeAll: vi.fn().mockResolvedValue({ recomputed: 1, failed: 0 }),
      fullRecompute: vi.fn().mockResolvedValue(JUDGMENT_ELEVATION_THRESHOLD + 0.1),
    };
    const contactService = {
      listContacts: vi.fn().mockResolvedValue(unknown),
      // Swallowed backend failure: elevateTierToKnown catches internally and returns false.
      elevateTierToKnown: vi.fn().mockResolvedValue(false),
      // Re-read still shows 'unknown' → the elevation genuinely failed.
      getContact: vi.fn().mockResolvedValue({ id: 'a', tier: 'unknown', kind: 'person' }),
    };

    const result = await runRederive(contactService as never, pipeline as never);

    expect(contactService.getContact).toHaveBeenCalledWith('a');
    expect(result.elevated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.failedContactIds).toEqual(['a']);
  });

  it('treats a false return as a benign skip when the contact is already elevated (concurrent no-op)', async () => {
    const unknown = [{ id: 'a', tier: 'unknown', kind: 'person', contactConfidence: 0 }];
    const pipeline = {
      fullRecomputeAll: vi.fn().mockResolvedValue({ recomputed: 1, failed: 0 }),
      fullRecompute: vi.fn().mockResolvedValue(JUDGMENT_ELEVATION_THRESHOLD + 0.1),
    };
    const contactService = {
      listContacts: vi.fn().mockResolvedValue(unknown),
      elevateTierToKnown: vi.fn().mockResolvedValue(false),
      // Re-read shows it is already 'known' → a concurrent elevation won the race.
      getContact: vi.fn().mockResolvedValue({ id: 'a', tier: 'known', kind: 'person' }),
    };

    const result = await runRederive(contactService as never, pipeline as never);

    expect(result.errors).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failedContactIds).toEqual([]);
  });

  it('folds fullRecomputeAll failures into the error count so the run is not reported as clean', async () => {
    // fullRecomputeAll catches per-contact recompute failures internally and resolves;
    // it returns the failed count rather than swallowing it, and runRederive must reflect
    // that in `errors` so the CLI exits non-zero.
    const pipeline = {
      fullRecomputeAll: vi.fn().mockResolvedValue({ recomputed: 8, failed: 2 }),
      fullRecompute: vi.fn(),
    };
    const contactService = {
      listContacts: vi.fn().mockResolvedValue([]), // no unknown candidates to elevate
      elevateTierToKnown: vi.fn(),
      getContact: vi.fn(),
    };

    const result = await runRederive(contactService as never, pipeline as never);

    expect(result.recomputed).toBe(8);
    expect(result.errors).toBe(2);
  });
});
