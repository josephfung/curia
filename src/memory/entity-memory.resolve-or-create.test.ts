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
import type { KgNode } from './types.js';

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

describe('EntityMemory.storeFact — contradiction auto-resolution', () => {
  it('returns auto_resolved, updates existing node label and confidence, and populates previous_values', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Bob', properties: {}, source: 'test',
    });

    // Store initial lower-confidence location fact
    const initial = await mem.storeFact({
      entityNodeId: entity.id,
      label: 'location: Kitchener',
      properties: { attribute: 'location', value: 'Kitchener' },
      confidence: 0.6,
      source: 'test',
    });
    expect(initial.action).toBe('created');
    const existingNodeId = initial.nodeId!;

    // Supersede with higher-confidence fact
    const result = await mem.storeFact({
      entityNodeId: entity.id,
      label: 'location: Toronto',
      properties: { attribute: 'location', value: 'Toronto' },
      confidence: 0.9,
      source: 'agent:coordinator/task:t1/channel:email',
    });

    expect(result.stored).toBe(true);
    expect(result.action).toBe('auto_resolved');
    // Same node ID — the existing node was updated in place, not replaced
    expect(result.nodeId).toBe(existingNodeId);

    // Verify node was updated in the store
    const updatedNode = await store.getNode(existingNodeId);
    expect(updatedNode?.label).toBe('location: Toronto');
    expect(updatedNode?.temporal.confidence).toBe(0.9);

    // Verify audit trail
    const pv = updatedNode!.properties.previous_values as Array<{
      label: string; confidence: number; replacedBy: string;
    }>;
    expect(Array.isArray(pv)).toBe(true);
    expect(pv).toHaveLength(1);
    expect(pv[0]!.label).toBe('location: Kitchener');
    expect(pv[0]!.confidence).toBe(0.6);
    expect(pv[0]!.replacedBy).toBe('agent:coordinator/task:t1/channel:email');
  });

  it('returns auto_rejected and leaves existing node unchanged when incoming confidence is lower', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Bob', properties: {}, source: 'test',
    });

    // Store a high-confidence location fact first
    const initial = await mem.storeFact({
      entityNodeId: entity.id,
      label: 'location: Kitchener',
      properties: { attribute: 'location', value: 'Kitchener' },
      confidence: 0.9,
      source: 'test',
    });
    expect(initial.action).toBe('created');
    const existingNodeId = initial.nodeId!;

    // Attempt to override with lower confidence — should be silently rejected
    const result = await mem.storeFact({
      entityNodeId: entity.id,
      label: 'location: Toronto',
      properties: { attribute: 'location', value: 'Toronto' },
      confidence: 0.7,
      source: 'agent:coordinator/task:t1/channel:email',
    });

    expect(result.stored).toBe(false);
    expect(result.action).toBe('auto_rejected');
    expect(result.conflict).toContain('Kitchener');
    expect(result.existingNodeId).toBe(existingNodeId);

    // The existing node must be untouched — no label or confidence change
    const existingNode = await store.getNode(existingNodeId);
    expect(existingNode?.label).toBe('location: Kitchener');
    expect(existingNode?.temporal.confidence).toBe(0.9);
  });
});

describe('KgNode aliases field', () => {
  it('newly created entity nodes have an empty aliases array', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Acme Corp', properties: {}, source: 'test',
    });

    expect(entity.aliases).toEqual([]);
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

describe('EntityMemory.findEntities — alias awareness', () => {
  it('finds an entity by alias when the canonical label does not match', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    // Create a node and manually set an alias on it via the store
    const node = await store.createNode({
      type: 'organization',
      label: 'Darlise Restaurant',
      properties: {},
      source: 'test',
    });
    // Simulate a learned alias by updating the node's aliases directly
    const withAlias: KgNode = { ...node, aliases: ['darlise'] };
    await store.updateNode(node.id, withAlias);

    const results = await mem.findEntities('Darlise');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(node.id);
  });

  it('does not match archived nodes via alias', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    const node = await store.createNode({
      type: 'organization',
      label: 'Darlise Restaurant',
      properties: {},
      source: 'test',
    });
    const withAlias: KgNode = { ...node, aliases: ['darlise'] };
    await store.updateNode(node.id, withAlias);
    await store.archiveNode(node.id);

    const results = await mem.findEntities('Darlise');
    expect(results).toHaveLength(0);
  });
});
