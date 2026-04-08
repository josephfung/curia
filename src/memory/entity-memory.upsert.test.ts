import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';
import { EntityMemory } from './entity-memory.js';
import { MemoryValidator } from './validation.js';

function makeEntityMemory() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return { mem: new EntityMemory(store, validator, embeddingService), store };
}

describe('EntityMemory.mergeEntities Phase 2', () => {
  it('re-points secondary edges to primary after merge', async () => {
    const { mem } = makeEntityMemory();
    const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });
    const org = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });

    // secondary has a relationship with org
    await mem.upsertEdge(secondary.id, org.id, 'member_of', {}, 'test', 0.8);

    await mem.mergeEntities(primary.id, secondary.id);

    // secondary node is gone
    expect(await mem.getEntity(secondary.id)).toBeUndefined();

    // primary now has the edge to org
    const edges = await mem.findEdges(primary.id);
    expect(edges.some(e => e.node.id === org.id && e.edge.type === 'member_of')).toBe(true);
  });

  it('does not duplicate edges that primary already has', async () => {
    const { mem } = makeEntityMemory();
    const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });
    const org = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });

    // both nodes already have the same relationship with org
    await mem.upsertEdge(primary.id, org.id, 'member_of', {}, 'test', 0.7);
    await mem.upsertEdge(secondary.id, org.id, 'member_of', {}, 'test', 0.9);

    await mem.mergeEntities(primary.id, secondary.id);

    const edges = await mem.findEdges(primary.id);
    const memberOfEdges = edges.filter(e => e.edge.type === 'member_of' && e.node.id === org.id);
    // exactly one edge, not two
    expect(memberOfEdges).toHaveLength(1);
    // confidence raised to the higher value
    expect(memberOfEdges[0]!.edge.temporal.confidence).toBe(0.9);
  });

  it('deletes the secondary node after merge', async () => {
    const { mem } = makeEntityMemory();
    const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });

    await mem.mergeEntities(primary.id, secondary.id);

    expect(await mem.getEntity(secondary.id)).toBeUndefined();
  });

  it('cleans up secondary fact nodes after merge (no orphans)', async () => {
    const { mem } = makeEntityMemory();
    const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });

    await mem.storeFact({
      entityNodeId: secondary.id,
      label: 'title: CEO',
      properties: {},
      confidence: 0.8,
      source: 'test',
    });

    // get the secondary fact node ID before merge
    const preMergeFacts = await mem.getFacts(secondary.id);
    expect(preMergeFacts).toHaveLength(1);
    const secondaryFactId = preMergeFacts[0]!.id;

    await mem.mergeEntities(primary.id, secondary.id);

    // secondary fact node itself is deleted (not orphaned)
    expect(await mem.getEntity(secondaryFactId)).toBeUndefined();

    // primary has the fact (re-stored in Phase 1)
    const primaryFacts = await mem.getFacts(primary.id);
    expect(primaryFacts.some(f => f.label === 'title: CEO')).toBe(true);
  });
});
