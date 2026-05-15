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

describe('KnowledgeGraphStore sensitivity defaults', () => {
  it('defaults sensitivity to internal when not specified on createNode', async () => {
    const store = makeStore();
    const node = await store.createNode({
      type: 'fact',
      label: 'quarterly target',
      properties: {},
      source: 'test',
    });
    expect(node.sensitivity).toBe('internal');
  });

  it('preserves explicit sensitivity when provided', async () => {
    const store = makeStore();
    const node = await store.createNode({
      type: 'fact',
      label: 'board minutes',
      properties: {},
      source: 'test',
      sensitivity: 'restricted',
    });
    expect(node.sensitivity).toBe('restricted');
  });
});

describe('KnowledgeGraphStore.addAlias', () => {
  it('returns true and appends alias when alias is new', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });

    const added = await store.addAlias(node.id, 'al');

    expect(added).toBe(true);
    const updated = await store.getNode(node.id);
    expect(updated!.aliases).toEqual(['al']);
  });

  it('returns false and does not duplicate when alias already exists', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    await store.addAlias(node.id, 'al');

    const added = await store.addAlias(node.id, 'al');

    expect(added).toBe(false);
    const updated = await store.getNode(node.id);
    expect(updated!.aliases).toEqual(['al']); // still exactly one copy
  });

  it('returns false when alias cap (10) is reached', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    for (let i = 0; i < 10; i++) {
      await store.addAlias(node.id, `alias-${i}`);
    }

    const added = await store.addAlias(node.id, 'one-more');

    expect(added).toBe(false);
    const updated = await store.getNode(node.id);
    expect(updated!.aliases).toHaveLength(10);
    expect(updated!.aliases).not.toContain('one-more');
  });

  it('returns false for an unknown nodeId', async () => {
    const store = makeStore();

    const added = await store.addAlias('does-not-exist', 'some-alias');

    expect(added).toBe(false);
  });

  it('returns false for an archived node', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    await store.archiveNode(node.id);

    const added = await store.addAlias(node.id, 'al');

    expect(added).toBe(false);
  });
});
