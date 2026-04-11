import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';

function makeStore() {
  return KnowledgeGraphStore.createInMemory(EmbeddingService.createForTesting());
}

describe('KnowledgeGraphStore: archived row filtering', () => {
  it('getNode returns undefined for an archived node', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'fact', label: 'stale fact', properties: {}, source: 'test' });
    await store.archiveNode(node.id);
    const result = await store.getNode(node.id);
    expect(result).toBeUndefined();
  });

  it('findNodesByType excludes archived nodes', async () => {
    const store = makeStore();
    const active = await store.createNode({ type: 'fact', label: 'active fact', properties: {}, source: 'test' });
    const archived = await store.createNode({ type: 'fact', label: 'archived fact', properties: {}, source: 'test' });
    await store.archiveNode(archived.id);
    const results = await store.findNodesByType('fact');
    expect(results.map(n => n.id)).toContain(active.id);
    expect(results.map(n => n.id)).not.toContain(archived.id);
  });

  it('findNodesByLabel excludes archived nodes', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'fact', label: 'decayed coffee pref', properties: {}, source: 'test' });
    await store.archiveNode(node.id);
    const results = await store.findNodesByLabel('decayed coffee pref');
    expect(results).toHaveLength(0);
  });

  it('getEdgesForNode excludes archived edges', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const edge = await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'collaborates_with', properties: {}, source: 'test' });
    await store.archiveEdge(edge.id);
    const edges = await store.getEdgesForNode(a.id);
    expect(edges).toHaveLength(0);
  });

  it('traverse excludes archived nodes and edges', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Traverse-A', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'project', label: 'Traverse-B', properties: {}, source: 'test' });
    await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'works_on', properties: {}, source: 'test' });
    await store.archiveNode(b.id);
    const result = await store.traverse(a.id, { maxDepth: 2 });
    expect(result.nodes.map(n => n.id)).not.toContain(b.id);
  });
});
