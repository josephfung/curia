import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';
import { EntityMemory } from './entity-memory.js';
import { MemoryValidator } from './validation.js';
import { createSilentLogger } from '../logger.js';

function makeEntityMemory() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService, createSilentLogger());
}

describe('EntityMemory.findEdges', () => {
  it('returns all edges for a node in both directions', async () => {
    const mem = makeEntityMemory();
    const { entity: bob } = await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const { entity: xiaopu } = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const { entity: acme } = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    await mem.upsertEdge(bob.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(acme.id, bob.id, 'member_of', {}, 'test', 0.8); // inbound to bob

    const results = await mem.findEdges(bob.id);
    expect(results).toHaveLength(2);
  });

  it('filters by edge type', async () => {
    const mem = makeEntityMemory();
    const { entity: bob } = await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const { entity: xiaopu } = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const { entity: acme } = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    await mem.upsertEdge(bob.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(bob.id, acme.id, 'member_of', {}, 'test', 0.8);

    const results = await mem.findEdges(bob.id, { type: 'spouse' });
    expect(results).toHaveLength(1);
    expect(results[0]!.edge.type).toBe('spouse');
    expect(results[0]!.node.label).toBe('Alice');
  });

  it('labels direction correctly', async () => {
    const mem = makeEntityMemory();
    const { entity: bob } = await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const { entity: xiaopu } = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    await mem.upsertEdge(bob.id, xiaopu.id, 'manages', {}, 'test', 0.8);

    const fromJoseph = await mem.findEdges(bob.id);
    const fromAlice = await mem.findEdges(xiaopu.id);

    expect(fromJoseph[0]!.direction).toBe('outbound');
    expect(fromAlice[0]!.direction).toBe('inbound');
  });

  it('filters out fact-type nodes', async () => {
    const mem = makeEntityMemory();
    const { entity: bob } = await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    // Store a fact — this creates a 'fact' node linked via 'relates_to' edge
    await mem.storeFact({ entityNodeId: bob.id, label: 'Lives in Toronto', source: 'test' });
    const { entity: xiaopu } = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    await mem.upsertEdge(bob.id, xiaopu.id, 'spouse', {}, 'test', 0.9);

    const results = await mem.findEdges(bob.id);
    // Should only return the spouse relationship, not the fact link
    expect(results).toHaveLength(1);
    expect(results[0]!.edge.type).toBe('spouse');
  });

  it('filters by direction:inbound', async () => {
    const mem = makeEntityMemory();
    const { entity: bob } = await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const { entity: xiaopu } = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const { entity: acme } = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    // bob manages xiaopu (outbound from bob)
    await mem.upsertEdge(bob.id, xiaopu.id, 'manages', {}, 'test', 0.8);
    // acme advises bob (inbound to bob)
    await mem.upsertEdge(acme.id, bob.id, 'advises', {}, 'test', 0.8);

    const inbound = await mem.findEdges(bob.id, { direction: 'inbound' });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.direction).toBe('inbound');
    expect(inbound[0]!.node.label).toBe('Acme');
  });
});

describe('EntityMemory.deleteEdge', () => {
  it('removes the edge so it no longer appears in findEdges', async () => {
    const mem = makeEntityMemory();
    const { entity: bob } = await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const { entity: xiaopu } = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const { edge } = await mem.upsertEdge(bob.id, xiaopu.id, 'spouse', {}, 'test', 0.9);

    await mem.deleteEdge(edge.id);

    const results = await mem.findEdges(bob.id);
    expect(results).toHaveLength(0);
  });
});
