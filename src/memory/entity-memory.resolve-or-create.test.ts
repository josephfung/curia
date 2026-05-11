// entity-memory.resolve-or-create.test.ts — unit tests for EntityMemory.resolveOrCreate()
// and the updated storeFact() action codes.
//
// Uses the in-memory KG backend — no Postgres required.

import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';
import { EntityMemory } from './entity-memory.js';
import { MemoryValidator, MAX_WRITES_PER_AGENT_TASK } from './validation.js';
import { createSilentLogger } from '../logger.js';

function makeEntityMemory() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return {
    mem: new EntityMemory(store, validator, embeddingService, createSilentLogger()),
    store,
    validator,
  };
}

describe('EntityMemory.resolveOrCreate', () => {
  it('creates a new entity when label has 0 KG matches', async () => {
    const { mem } = makeEntityMemory();
    const result = await mem.resolveOrCreate({
      label: 'Acme Corp',
      type: 'organization',
      source: 'test',
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('narrowing');
    expect(result.node.label).toBe('Acme Corp');
    expect(result.node.type).toBe('organization');
  });

  it('returns found when label has exactly 1 KG match', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Jane Doe', properties: {}, source: 'test',
    });

    const result = await mem.resolveOrCreate({
      label: 'Jane Doe',
      type: 'person',
      source: 'test',
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('narrowing');
    expect(result.node.id).toBe(entity.id);
  });

  it('returns the type-matching node when 2+ labels match and one has the right type', async () => {
    // Insert two nodes with the same label but different types via the store directly,
    // bypassing upsert (which would merge them).
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    const personNode = await store.createNode({
      type: 'person', label: 'River', properties: {}, source: 'test',
    });
    await store.createNode({
      type: 'organization', label: 'River', properties: {}, source: 'test',
    });

    const result = await mem.resolveOrCreate({
      label: 'River',
      type: 'person',
      source: 'test',
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('narrowing');
    expect(result.node.id).toBe(personNode.id);
  });

  it('returns ambiguous when 2+ labels match and none has the right type', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    await store.createNode({ type: 'person', label: 'River', properties: {}, source: 'test' });
    await store.createNode({ type: 'organization', label: 'River', properties: {}, source: 'test' });

    const result = await mem.resolveOrCreate({
      label: 'River',
      type: 'event',   // no match for this type
      source: 'test',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('narrowing');
    expect(result.candidates).toHaveLength(2);
  });

  it('returns found (with existing type) when 1 match exists but type differs from caller hint', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Acme', properties: {}, source: 'test',
    });

    const result = await mem.resolveOrCreate({
      label: 'Acme',
      type: 'organization',  // differs from the existing 'person' node
      source: 'test',
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('narrowing');
    expect(result.node.id).toBe(entity.id);
    expect(result.node.type).toBe('person');  // returns the existing node as-is
  });

  it('uses the caller-supplied confidence when auto-creating', async () => {
    const { mem } = makeEntityMemory();
    const result = await mem.resolveOrCreate({
      label: 'New Concept',
      type: 'concept',
      source: 'test',
      confidence: 0.4,
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('narrowing');
    expect(result.node.temporal.confidence).toBe(0.4);
  });

  it('defaults confidence to 0.6 when omitted', async () => {
    const { mem } = makeEntityMemory();
    const result = await mem.resolveOrCreate({
      label: 'Default Confidence Entity',
      type: 'concept',
      source: 'test',
      // confidence omitted — should default to 0.6
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('narrowing');
    expect(result.node.temporal.confidence).toBe(0.6);
  });
});

describe('EntityMemory.storeFact — updated action codes', () => {
  it('returns action:entity_not_found when entity node does not exist', async () => {
    const { mem } = makeEntityMemory();
    const result = await mem.storeFact({
      entityNodeId: '00000000-0000-0000-0000-000000000000',
      label: 'favourite_color: blue',
      properties: { attribute: 'favourite_color', value: 'blue' },
      source: 'test',
    });

    expect(result.stored).toBe(false);
    expect(result.action).toBe('entity_not_found');
  });

  it('returns action:rate_limited when write limit is exhausted', async () => {
    const { mem, validator } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Jane', properties: {}, source: 'test',
    });
    const source = 'agent:coordinator/task:limit-test';

    // Exhaust the write limit without touching storeFact's DB path
    for (let i = 0; i < MAX_WRITES_PER_AGENT_TASK; i++) {
      validator.recordWrite(source);
    }

    const result = await mem.storeFact({
      entityNodeId: entity.id,
      label: 'role: engineer',
      properties: { attribute: 'role', value: 'engineer' },
      source,
    });

    expect(result.stored).toBe(false);
    expect(result.action).toBe('rate_limited');
  });
});
