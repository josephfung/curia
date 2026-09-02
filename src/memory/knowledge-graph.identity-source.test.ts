// Two-tier node identity (ADR-040, #1694).
//
// These exercise the in-memory backend, which mirrors the partial index
// idx_kg_nodes_unique. The Postgres side of the same invariants is covered in
// tests/integration/knowledge-graph.test.ts, where the index itself does the enforcing.

import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';

function makeStore() {
  return KnowledgeGraphStore.createInMemory(EmbeddingService.createForTesting());
}

describe('KnowledgeGraphStore identity tiers', () => {
  it('createNode defaults to the label tier', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Dana Wu', properties: {}, source: 'test' });
    expect(node.identitySource).toBe('label');
  });

  it('createNode mints an anchored node when asked', async () => {
    const store = makeStore();
    const node = await store.createNode({
      type: 'person', label: 'Dana Wu', properties: {}, source: 'test', identitySource: 'contact',
    });
    expect(node.identitySource).toBe('contact');
  });

  it('createNode allows two anchored nodes to share a label', async () => {
    // The whole point of #1694: two people called "Seth Berman" each hold a node.
    const store = makeStore();
    const first = await store.createNode({
      type: 'person', label: 'Seth Berman', properties: {}, source: 'test', identitySource: 'contact',
    });
    const second = await store.createNode({
      type: 'person', label: 'Seth Berman', properties: {}, source: 'test', identitySource: 'contact',
    });

    expect(second.id).not.toBe(first.id);
    const found = await store.findNodesByLabel('Seth Berman');
    expect(found.map(n => n.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('upsertNode only ever writes label-tier rows (ADR-040 invariant 1)', async () => {
    const store = makeStore();
    const { node } = await store.upsertNode({
      type: 'person', label: 'Dana Wu', properties: {}, source: 'test', confidence: 0.7,
    });
    expect(node.identitySource).toBe('label');
  });

  it('upsertNode never merges onto an anchored node — it inserts alongside it', async () => {
    // This is the seam the two tiers leak through if it regresses: a name-only write
    // landing on somebody's contact identity.
    const store = makeStore();
    const anchored = await store.createNode({
      type: 'person', label: 'Seth Berman', properties: {}, source: 'contact-create', identitySource: 'contact',
    });

    const { node, created } = await store.upsertNode({
      type: 'person', label: 'Seth Berman', properties: {}, source: 'extraction', confidence: 0.7,
    });

    expect(created).toBe(true);
    expect(node.id).not.toBe(anchored.id);
    expect(node.identitySource).toBe('label');
  });

  it('upsertNode still deduplicates label-tier nodes', async () => {
    const store = makeStore();
    const { node: first } = await store.upsertNode({
      type: 'person', label: 'Dana Wu', properties: {}, source: 'test', confidence: 0.7,
    });
    const { node: second, created } = await store.upsertNode({
      type: 'person', label: 'dana wu', properties: {}, source: 'test', confidence: 0.9,
    });

    expect(created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.temporal.confidence).toBe(0.9);
  });
});

describe('KnowledgeGraphStore.anchorNode', () => {
  it('promotes a label-tier node and reports success', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Dana Wu', properties: {}, source: 'test' });

    expect(await store.anchorNode(node.id)).toBe(true);
    expect((await store.getNode(node.id))?.identitySource).toBe('contact');
  });

  it('refuses a node that is already anchored — the adoption race guard', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Dana Wu', properties: {}, source: 'test' });

    expect(await store.anchorNode(node.id)).toBe(true);
    // Second contact racing for the same node must lose rather than share an identity.
    expect(await store.anchorNode(node.id)).toBe(false);
  });

  it('refuses an archived node', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Dana Wu', properties: {}, source: 'test' });
    await store.archiveNode(node.id);

    expect(await store.anchorNode(node.id)).toBe(false);
  });

  it('refuses a node that does not exist', async () => {
    const store = makeStore();
    expect(await store.anchorNode('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('leaves an adopted node reachable by label so ambiguity stays visible', async () => {
    // findNodesByLabel deliberately keeps returning anchored nodes: hiding them would
    // let resolveOrCreate mint a third "Seth Berman" on every write (ADR-040).
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Seth Berman', properties: {}, source: 'test' });
    await store.anchorNode(node.id);

    const found = await store.findNodesByLabel('Seth Berman');
    expect(found.map(n => n.id)).toEqual([node.id]);
  });
});
