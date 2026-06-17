import { describe, it, expect, vi } from 'vitest';
import { writeExclusion, hasExclusion } from './dedup-exclusions.js';
import type { KgNode } from '../memory/types.js';

function makeFactNode(overrides: { attribute: string; value: string; id?: string }): KgNode {
  return {
    id: overrides.id ?? 'fn-1',
    type: 'fact' as const,
    label: `dedup_exclusion: ${overrides.value}`,
    properties: { attribute: overrides.attribute, value: overrides.value },
    aliases: [],
    sensitivity: 'internal' as const,
    temporal: {
      createdAt: new Date(),
      lastConfirmedAt: new Date(),
      confidence: 1.0,
      decayClass: 'permanent' as const,
      source: 'contacts-dedup',
    },
  };
}

// ---------------------------------------------------------------------------
// writeExclusion
// ---------------------------------------------------------------------------

describe('writeExclusion', () => {
  it('calls storeFact with the correct attribute and value for a dedup_exclusion', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({
      contactBId: 'c2',
      kgNodeId: 'kg-c1',
      storeFact: storeFactMock,
    });

    expect(storeFactMock).toHaveBeenCalledOnce();
    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.entityNodeId).toBe('kg-c1');
    expect((args.properties as Record<string, unknown>).attribute).toBe('dedup_exclusion');
    expect((args.properties as Record<string, unknown>).value).toBe('c2');
    // Exclusion facts must be permanent so they survive decay
    expect(args.decayClass).toBe('permanent');
  });

  it('writes the exclusion label in the expected format', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({ contactBId: 'c2', kgNodeId: 'kg-c1', storeFact: storeFactMock });

    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.label).toBe('dedup_exclusion: c2');
  });

  it('defaults source to contacts-dedup when not provided', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({ contactBId: 'c2', kgNodeId: 'kg-c1', storeFact: storeFactMock });

    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.source).toBe('contacts-dedup');
  });

  it('uses the provided source when supplied', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({
      contactBId: 'c2',
      kgNodeId: 'kg-c1',
      storeFact: storeFactMock,
      source: 'agent:contacts/task:t1/channel:cli',
    });

    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.source).toBe('agent:contacts/task:t1/channel:cli');
  });

  it('throws when storeFact returns stored: false (e.g. conflict with existing exclusion for different pair)', async () => {
    // This exercises the critical path where EntityMemory contradiction detection fires
    // because the same attribute ('dedup_exclusion') already exists on the node for a
    // different pair (different label/value). Without the throw, the handler would
    // silently treat the non-stored fact as written and return success to the agent.
    const storeFactMock = vi.fn().mockResolvedValue({
      stored: false,
      action: 'conflict',
      conflict: 'Contradicts existing fact dedup_exclusion: c3 (same attribute, different label, equal confidence)',
    });

    await expect(
      writeExclusion({ contactBId: 'c2', kgNodeId: 'kg-c1', storeFact: storeFactMock }),
    ).rejects.toThrow(/not stored.*action: conflict/);
  });
});

// ---------------------------------------------------------------------------
// hasExclusion
// ---------------------------------------------------------------------------

describe('hasExclusion', () => {
  it('returns true when the KG node has a dedup_exclusion fact for the other contact', async () => {
    const getFactsMock = vi.fn().mockResolvedValue([
      makeFactNode({ attribute: 'dedup_exclusion', value: 'c2' }),
    ]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    expect(result).toBe(true);
  });

  it('returns false when no dedup_exclusion fact exists', async () => {
    const getFactsMock = vi.fn().mockResolvedValue([]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    expect(result).toBe(false);
  });

  it('returns false when neither contact has a kg_node_id', async () => {
    const getFactsMock = vi.fn().mockResolvedValue([]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: null,
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    expect(result).toBe(false);
    // No KG nodes → no facts possible; should not even attempt to fetch
    expect(getFactsMock).not.toHaveBeenCalled();
  });

  it('checks both sides when both contacts have kg_node_ids', async () => {
    // Exclusion is on B's node naming A
    const getFactsMock = vi.fn().mockImplementation(async (kgNodeId: string) => {
      if (kgNodeId === 'kg-c2') {
        return [makeFactNode({ attribute: 'dedup_exclusion', value: 'c1', id: 'fn-2' })];
      }
      return [];
    });

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: 'kg-c2',
      getFacts: getFactsMock,
    });

    expect(result).toBe(true);
  });
});
