import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';

describe('KnowledgeGraphStore', () => {
  let store: KnowledgeGraphStore;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    store = KnowledgeGraphStore.createInMemory(embeddingService);
  });

  describe('node CRUD', () => {
    it('creates and retrieves a node by ID', async () => {
      const node = await store.createNode({
        type: 'person',
        label: 'Jane Doe',
        properties: { title: 'CEO' },
        confidence: 0.9,
        decayClass: 'permanent',
        source: 'agent:coordinator/task:test',
      });
      expect(node.id).toBeDefined();
      expect(node.type).toBe('person');
      expect(node.label).toBe('Jane Doe');
      const retrieved = await store.getNode(node.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.label).toBe('Jane Doe');
    });

    it('returns undefined for non-existent node', async () => {
      const result = await store.getNode('non-existent-id');
      expect(result).toBeUndefined();
    });

    it('updates node properties and refreshes last_confirmed_at', async () => {
      const node = await store.createNode({
        type: 'person',
        label: 'Bob',
        properties: { city: 'Kitchener' },
        source: 'test',
      });
      const originalConfirmed = node.temporal.lastConfirmedAt;
      const updated = await store.updateNode(node.id, {
        properties: { city: 'Toronto', title: 'CEO' },
      });
      expect(updated.properties).toEqual({ city: 'Toronto', title: 'CEO' });
      expect(updated.temporal.lastConfirmedAt.getTime()).toBeGreaterThanOrEqual(originalConfirmed.getTime());
    });

    it('re-embeds when label changes on update', async () => {
      const node = await store.createNode({
        type: 'concept',
        label: 'original label',
        properties: {},
        source: 'test',
      });
      const originalEmbedding = node.embedding;
      expect(originalEmbedding).toBeDefined();
      const updated = await store.updateNode(node.id, { label: 'completely different label' });
      expect(updated.embedding).toBeDefined();
      expect(updated.embedding).not.toEqual(originalEmbedding);
    });

    it('deletes a node', async () => {
      const node = await store.createNode({
        type: 'concept',
        label: 'Temporary',
        properties: {},
        source: 'test',
      });
      await store.deleteNode(node.id);
      expect(await store.getNode(node.id)).toBeUndefined();
    });

    it('cascade-deletes edges when a node is deleted', async () => {
      const a = await store.createNode({ type: 'person', label: 'A', properties: {}, source: 'test' });
      const b = await store.createNode({ type: 'person', label: 'B', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'relates_to', properties: {}, source: 'test' });

      await store.deleteNode(a.id);
      const edges = await store.getEdgesForNode(b.id);
      expect(edges).toHaveLength(0);
    });

    it('finds nodes by type', async () => {
      await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
      await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
      await store.createNode({ type: 'project', label: 'Curia', properties: {}, source: 'test' });
      const people = await store.findNodesByType('person');
      expect(people).toHaveLength(2);
    });

    it('finds nodes by label (case-insensitive)', async () => {
      await store.createNode({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });
      const results = await store.findNodesByLabel('joseph fung');
      expect(results).toHaveLength(1);
      expect(results[0]!.label).toBe('Jane Doe');
    });
  });

  describe('edge CRUD', () => {
    it('creates an edge between two nodes', async () => {
      const person = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
      const project = await store.createNode({ type: 'project', label: 'Curia', properties: {}, source: 'test' });
      const edge = await store.createEdge({
        sourceNodeId: person.id,
        targetNodeId: project.id,
        type: 'works_on',
        properties: { role: 'lead' },
        source: 'test',
      });
      expect(edge.id).toBeDefined();
      expect(edge.type).toBe('works_on');
    });

    it('retrieves edges for a node', async () => {
      const person = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
      const p1 = await store.createNode({ type: 'project', label: 'P1', properties: {}, source: 'test' });
      const p2 = await store.createNode({ type: 'project', label: 'P2', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: person.id, targetNodeId: p1.id, type: 'works_on', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: person.id, targetNodeId: p2.id, type: 'works_on', properties: {}, source: 'test' });
      const edges = await store.getEdgesForNode(person.id);
      expect(edges).toHaveLength(2);
    });

    it('deletes an edge', async () => {
      const a = await store.createNode({ type: 'person', label: 'A', properties: {}, source: 'test' });
      const b = await store.createNode({ type: 'person', label: 'B', properties: {}, source: 'test' });
      const edge = await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'relates_to', properties: {}, source: 'test' });
      await store.deleteEdge(edge.id);
      const edges = await store.getEdgesForNode(a.id);
      expect(edges).toHaveLength(0);
    });
  });

  describe('graph traversal', () => {
    it('traverses connected nodes up to depth limit', async () => {
      const a = await store.createNode({ type: 'person', label: 'A', properties: {}, source: 'test' });
      const b = await store.createNode({ type: 'project', label: 'B', properties: {}, source: 'test' });
      const c = await store.createNode({ type: 'decision', label: 'C', properties: {}, source: 'test' });
      const d = await store.createNode({ type: 'concept', label: 'D', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'works_on', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: b.id, targetNodeId: c.id, type: 'relates_to', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: c.id, targetNodeId: d.id, type: 'relates_to', properties: {}, source: 'test' });
      const result = await store.traverse(a.id, { maxDepth: 2 });
      const labels = result.nodes.map(n => n.label).sort();
      expect(labels).toEqual(['A', 'B', 'C']);
      expect(result.edges).toHaveLength(2);
    });

    it('handles cycles without infinite loops or duplicate nodes', async () => {
      const a = await store.createNode({ type: 'person', label: 'A', properties: {}, source: 'test' });
      const b = await store.createNode({ type: 'project', label: 'B', properties: {}, source: 'test' });
      const c = await store.createNode({ type: 'decision', label: 'C', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'relates_to', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: b.id, targetNodeId: c.id, type: 'relates_to', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: c.id, targetNodeId: a.id, type: 'relates_to', properties: {}, source: 'test' });

      const result = await store.traverse(a.id, { maxDepth: 10 });
      expect(result.nodes).toHaveLength(3);
      expect(result.edges).toHaveLength(3);
    });

    it('defaults to depth 3 (spec requirement)', async () => {
      const a = await store.createNode({ type: 'person', label: 'A', properties: {}, source: 'test' });
      const b = await store.createNode({ type: 'project', label: 'B', properties: {}, source: 'test' });
      const c = await store.createNode({ type: 'decision', label: 'C', properties: {}, source: 'test' });
      const d = await store.createNode({ type: 'concept', label: 'D', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'works_on', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: b.id, targetNodeId: c.id, type: 'relates_to', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: c.id, targetNodeId: d.id, type: 'relates_to', properties: {}, source: 'test' });
      const result = await store.traverse(a.id);
      expect(result.nodes).toHaveLength(4);
    });
  });

  describe('semantic search', () => {
    it('finds nodes by semantic similarity', async () => {
      await store.createNode({ type: 'concept', label: 'fundraising strategy', properties: {}, source: 'test' });
      await store.createNode({ type: 'concept', label: 'engineering hiring plan', properties: {}, source: 'test' });
      const results = await store.semanticSearch('raising money for the company');
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.node).toBeDefined();
        expect(typeof r.score).toBe('number');
      }
    });
  });
});
