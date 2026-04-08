import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';

function makeStore() {
  const embeddingService = EmbeddingService.createForTesting();
  return KnowledgeGraphStore.createInMemory(embeddingService);
}

describe('KnowledgeGraphStore.upsertEdge', () => {
  it('creates a new edge and returns created:true', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });

    const { edge, created } = await store.upsertEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      type: 'collaborates_with',
      properties: {},
      confidence: 0.8,
      source: 'test',
    });

    expect(created).toBe(true);
    expect(edge.type).toBe('collaborates_with');
    expect(edge.temporal.confidence).toBe(0.8);
  });

  it('returns created:false and raises confidence on second call (idempotency)', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });

    await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.7, source: 'test' });
    const { edge, created } = await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.9, source: 'test' });

    expect(created).toBe(false);
    expect(edge.temporal.confidence).toBe(0.9); // raised
  });

  it('treats reverse direction as the same edge', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });

    await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.8, source: 'test' });
    const { created } = await store.upsertEdge({ sourceNodeId: b.id, targetNodeId: a.id, type: 'spouse', properties: {}, confidence: 0.8, source: 'test' });

    expect(created).toBe(false);
    // Only one edge should exist
    const edges = await store.getEdgesForNode(a.id);
    expect(edges).toHaveLength(1);
  });

  it('never lowers confidence on re-assertion', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });

    await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.9, source: 'test' });
    const { edge } = await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.5, source: 'test' });

    expect(edge.temporal.confidence).toBe(0.9); // not lowered
  });
});

describe('KnowledgeGraphStore.upsertNode', () => {
  it('creates a new node and returns created:true', async () => {
    const store = makeStore();

    const { node, created } = await store.upsertNode({
      type: 'person',
      label: 'Alice',
      properties: {},
      confidence: 0.8,
      source: 'test',
    });

    expect(created).toBe(true);
    expect(node.label).toBe('Alice');
    expect(node.temporal.confidence).toBe(0.8);
  });

  it('returns existing node with created:false on same (label, type)', async () => {
    const store = makeStore();

    const { node: first } = await store.upsertNode({ type: 'person', label: 'Alice', properties: {}, confidence: 0.8, source: 'test' });
    const { node: second, created } = await store.upsertNode({ type: 'person', label: 'ALICE', properties: { extra: true }, confidence: 0.9, source: 'test' });

    expect(created).toBe(false);
    expect(second.id).toBe(first.id);
    // Confidence raised
    expect(second.temporal.confidence).toBe(0.9);
    // Properties NOT overwritten on conflict
    expect(second.properties).not.toHaveProperty('extra');
  });

  it('never lowers confidence on re-assertion', async () => {
    const store = makeStore();

    await store.upsertNode({ type: 'person', label: 'Alice', properties: {}, confidence: 0.9, source: 'test' });
    const { node } = await store.upsertNode({ type: 'person', label: 'Alice', properties: {}, confidence: 0.5, source: 'test' });

    expect(node.temporal.confidence).toBe(0.9);
  });

  it('allows same label under different types', async () => {
    const store = makeStore();

    const { created: c1 } = await store.upsertNode({ type: 'person', label: 'Apple', properties: {}, confidence: 0.8, source: 'test' });
    const { created: c2 } = await store.upsertNode({ type: 'organization', label: 'Apple', properties: {}, confidence: 0.8, source: 'test' });

    expect(c1).toBe(true);
    expect(c2).toBe(true);
  });

  it('always creates fact nodes regardless of label collision', async () => {
    const store = makeStore();

    const { created: c1 } = await store.upsertNode({ type: 'fact', label: 'CEO', properties: {}, confidence: 0.8, source: 'test' });
    const { created: c2 } = await store.upsertNode({ type: 'fact', label: 'CEO', properties: {}, confidence: 0.8, source: 'test' });

    expect(c1).toBe(true);
    expect(c2).toBe(true); // fact nodes are always new inserts, not upserts
  });
});
