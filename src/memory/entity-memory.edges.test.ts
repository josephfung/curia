import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';
import { EntityMemory } from './entity-memory.js';
import { MemoryValidator } from './validation.js';

function makeEntityMemory() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService);
}

describe('EntityMemory.findEdges', () => {
  it('returns all edges for a node in both directions', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(acme.id, joseph.id, 'member_of', {}, 'test', 0.8); // inbound to joseph

    const results = await mem.findEdges(joseph.id);
    expect(results).toHaveLength(2);
  });

  it('filters by edge type', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(joseph.id, acme.id, 'member_of', {}, 'test', 0.8);

    const results = await mem.findEdges(joseph.id, { type: 'spouse' });
    expect(results).toHaveLength(1);
    expect(results[0]!.edge.type).toBe('spouse');
    expect(results[0]!.node.label).toBe('Xiaopu');
  });

  it('labels direction correctly', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'manages', {}, 'test', 0.8);

    const fromJoseph = await mem.findEdges(joseph.id);
    const fromXiaopu = await mem.findEdges(xiaopu.id);

    expect(fromJoseph[0]!.direction).toBe('outbound');
    expect(fromXiaopu[0]!.direction).toBe('inbound');
  });

  it('filters out fact-type nodes', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    // Store a fact — this creates a 'fact' node linked via 'relates_to' edge
    await mem.storeFact({ entityNodeId: joseph.id, label: 'Lives in Toronto', source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);

    const results = await mem.findEdges(joseph.id);
    // Should only return the spouse relationship, not the fact link
    expect(results).toHaveLength(1);
    expect(results[0]!.edge.type).toBe('spouse');
  });

  it('filters by direction:inbound', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    // joseph manages xiaopu (outbound from joseph)
    await mem.upsertEdge(joseph.id, xiaopu.id, 'manages', {}, 'test', 0.8);
    // acme advises joseph (inbound to joseph)
    await mem.upsertEdge(acme.id, joseph.id, 'advises', {}, 'test', 0.8);

    const inbound = await mem.findEdges(joseph.id, { direction: 'inbound' });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.direction).toBe('inbound');
    expect(inbound[0]!.node.label).toBe('Acme');
  });
});

describe('EntityMemory.deleteEdge', () => {
  it('removes the edge so it no longer appears in findEdges', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const { edge } = await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);

    await mem.deleteEdge(edge.id);

    const results = await mem.findEdges(joseph.id);
    expect(results).toHaveLength(0);
  });
});
