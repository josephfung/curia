// entity-memory.resolve-or-create.test.ts — unit tests for EntityMemory.resolveOrCreate()
// and the updated storeFact() action codes.
//
// Uses the in-memory KG backend — no Postgres required.

import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';
import { EntityMemory, FUZZY_RESOLVE_THRESHOLD, FUZZY_AMBIGUITY_FLOOR, MAX_ALIASES_PER_ENTITY } from './entity-memory.js';
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

describe('EntityMemory.addAlias', () => {
  it('appends a lowercased alias to the entity node', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });

    await mem.addAlias(entity.id, 'Darlise');

    const updated = await store.getNode(entity.id);
    expect(updated!.aliases).toEqual(['darlise']);
  });

  it('does not add duplicate aliases', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });

    await mem.addAlias(entity.id, 'Darlise');
    await mem.addAlias(entity.id, 'DARLISE'); // same after lowering

    const updated = await store.getNode(entity.id);
    expect(updated!.aliases).toEqual(['darlise']);
  });

  it('does not add an alias that matches the canonical label', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });

    await mem.addAlias(entity.id, 'Darlise Restaurant');

    const updated = await store.getNode(entity.id);
    expect(updated!.aliases).toEqual([]);
  });

  it('rejects when alias count reaches MAX_ALIASES_PER_ENTITY', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });

    // Fill up to the cap
    for (let i = 0; i < MAX_ALIASES_PER_ENTITY; i++) {
      await mem.addAlias(entity.id, `alias-${i}`);
    }

    const updated = await store.getNode(entity.id);
    expect(updated!.aliases).toHaveLength(MAX_ALIASES_PER_ENTITY);

    // One more alias should be silently rejected
    await mem.addAlias(entity.id, 'one-too-many');
    const afterReject = await store.getNode(entity.id);
    expect(afterReject!.aliases).toHaveLength(MAX_ALIASES_PER_ENTITY);
    expect(afterReject!.aliases).not.toContain('one-too-many');
  });
});

describe('EntityMemory.resolveOrCreate — fuzzy fallback', () => {
  it('creates a new entity when no fuzzy match exceeds the ambiguity floor', async () => {
    const { mem } = makeEntityMemory();
    // Create an entity with a completely unrelated name
    await mem.createEntity({
      type: 'organization', label: 'Alpha Industries', properties: {}, source: 'test',
    });
    await mem.createEntity({
      type: 'organization', label: 'Beta Systems', properties: {}, source: 'test',
    });

    // This label is unrelated — should create, not match
    const result = await mem.resolveOrCreate({
      label: 'Gamma Innovations',
      type: 'organization',
      source: 'test',
    });

    expect(result.kind).toBe('created');
  });

  it('finds via alias so no fuzzy fallback is needed', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });

    await mem.addAlias(entity.id, 'darlise');

    const result = await mem.resolveOrCreate({
      label: 'Darlise',
      type: 'organization',
      source: 'test',
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('narrowing');
    expect(result.node.id).toBe(entity.id);
  });

  it('exports threshold constants with correct relative ordering', () => {
    expect(FUZZY_RESOLVE_THRESHOLD).toBe(0.90);
    expect(FUZZY_AMBIGUITY_FLOOR).toBe(0.75);
    expect(FUZZY_RESOLVE_THRESHOLD).toBeGreaterThan(FUZZY_AMBIGUITY_FLOOR);
  });
});

describe('EntityMemory.resolveOrCreate — fuzzy auto-resolve end-to-end', () => {
  it('auto-resolves via fuzzy match when embedding similarity >= FUZZY_RESOLVE_THRESHOLD', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    // Pre-compute the embedding for the query label we will use
    const queryLabel = 'Darlise';
    const queryEmbedding = await embeddingService.embed(queryLabel);

    // Create a node whose embedding matches the query exactly (cosine similarity = 1.0)
    // but whose canonical label is different — so Phase 1 (exact match) will miss
    // and Phase 2 (fuzzy) will fire.
    const node = await store.createNode({
      type: 'organization',
      label: 'Darlise Restaurant',
      properties: {},
      source: 'test',
      embedding: queryEmbedding,  // identical vector → similarity 1.0
    });

    const result = await mem.resolveOrCreate({
      label: queryLabel,
      type: 'organization',
      source: 'test',
    });

    // Phase 2 fires: similarity = 1.0 ≥ 0.90 → auto-resolve
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('narrowing');
    expect(result.node.id).toBe(node.id);

    // Alias is learned as a side effect of auto-resolve
    const refreshed = await store.getNode(node.id);
    expect(refreshed!.aliases).toContain(queryLabel.toLowerCase());
  });

  it('does not create a duplicate when a fuzzy match auto-resolves', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    const queryLabel = 'the Darlise place';
    const queryEmbedding = await embeddingService.embed(queryLabel);

    await store.createNode({
      type: 'organization',
      label: 'Darlise Restaurant',
      properties: {},
      source: 'test',
      embedding: queryEmbedding,
    });

    // Resolve once — should auto-resolve, not create
    const result = await mem.resolveOrCreate({
      label: queryLabel,
      type: 'organization',
      source: 'test',
    });

    expect(result.kind).toBe('found');

    // Only one organization node should exist — no duplicate created
    const allOrgs = await store.findNodesByType('organization');
    expect(allOrgs).toHaveLength(1);
  });

  it('returns ambiguous when best score is in the uncertain zone (0.75-0.90)', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    const queryLabel = 'Restaurant X';
    const queryEmbedding = await embeddingService.embed(queryLabel);

    // Build a vector that is 0.82 similar to the query embedding (in the ambiguous zone).
    // We do this by computing a weighted blend: blend = 0.82 * query + sqrt(1 - 0.82^2) * perp
    // where perp is orthogonal to query, giving exact cosine(blend, query) = 0.82.
    // For a simpler approximation: scale query and add a small orthogonal component.
    const norm = Math.sqrt(queryEmbedding.reduce((s, v) => s + v * v, 0));
    // Create a perturbed vector: keep 82% of the direction, add 18% noise on first dim
    const perturbedEmbedding = queryEmbedding.map((v, i) => {
      const scaled = v * 0.82;
      return i === 0 ? scaled + norm * Math.sqrt(1 - 0.82 * 0.82) : scaled;
    });

    // Verify the perturbation math lands in the ambiguous zone [0.75, 0.90)
    // before proceeding — this makes the test self-validating.
    const actualSimilarity = EmbeddingService.cosineSimilarity(queryEmbedding, perturbedEmbedding);
    expect(actualSimilarity).toBeGreaterThanOrEqual(FUZZY_AMBIGUITY_FLOOR);
    expect(actualSimilarity).toBeLessThan(FUZZY_RESOLVE_THRESHOLD);

    await store.createNode({
      type: 'organization',
      label: 'Another Restaurant',
      properties: {},
      source: 'test',
      embedding: perturbedEmbedding,
    });

    const result = await mem.resolveOrCreate({
      label: queryLabel,
      type: 'organization',
      source: 'test',
    });

    // Should be ambiguous (0.75 ≤ score < 0.90), not found and not created
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('narrowing');
    expect(result.candidates).toHaveLength(1);
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
    await store.updateNode(node.id, { aliases: ['darlise'] });

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
    await store.updateNode(node.id, { aliases: ['darlise'] });
    await store.archiveNode(node.id);

    const results = await mem.findEntities('Darlise');
    expect(results).toHaveLength(0);
  });
});

describe('EntityMemory.mergeEntities — alias consolidation', () => {
  it('unions secondary aliases into primary on merge', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity: primary } = await mem.createEntity({
      type: 'person', label: 'Jane Doe', properties: {}, source: 'test',
    });
    // Use a label that does not conflict with the aliases we intend to add:
    // addAlias() silently skips aliases that match the canonical label (case-insensitive),
    // so 'Jane Smith' lets us test 'jane' as a stored alias.
    const { entity: secondary } = await mem.createEntity({
      type: 'person', label: 'Jane Smith', properties: {}, source: 'test',
    });
    await mem.addAlias(primary.id, 'jane-doe');
    await mem.addAlias(secondary.id, 'jane');
    await mem.addAlias(secondary.id, 'j-doe');

    await mem.mergeEntities(primary.id, secondary.id);

    const surviving = await store.getNode(primary.id);
    expect(surviving!.aliases).toContain('jane-doe');  // primary's own alias
    expect(surviving!.aliases).toContain('jane');       // from secondary
    expect(surviving!.aliases).toContain('j-doe');      // from secondary
    // No duplicates
    expect(new Set(surviving!.aliases).size).toBe(surviving!.aliases.length);
  });

  it('deduplicates aliases that appear on both nodes', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity: primary } = await mem.createEntity({
      type: 'person', label: 'Jane Doe', properties: {}, source: 'test',
    });
    const { entity: secondary } = await mem.createEntity({
      type: 'person', label: 'Jane', properties: {}, source: 'test',
    });
    await mem.addAlias(primary.id, 'shared-alias');
    await mem.addAlias(secondary.id, 'shared-alias');
    await mem.addAlias(secondary.id, 'extra');

    await mem.mergeEntities(primary.id, secondary.id);

    const surviving = await store.getNode(primary.id);
    const count = surviving!.aliases.filter(a => a === 'shared-alias').length;
    expect(count).toBe(1);
    expect(surviving!.aliases).toContain('extra');
  });

  it('caps the alias union at MAX_ALIASES_PER_ENTITY and preserves primary aliases first', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity: primary } = await mem.createEntity({
      type: 'person', label: 'Primary', properties: {}, source: 'test',
    });
    const { entity: secondary } = await mem.createEntity({
      type: 'person', label: 'Secondary', properties: {}, source: 'test',
    });

    // Fill primary with 8 aliases
    for (let i = 0; i < 8; i++) {
      await mem.addAlias(primary.id, `primary-alias-${i}`);
    }
    // Give secondary 5 aliases (only 2 can fit into the cap of 10)
    for (let i = 0; i < 5; i++) {
      await mem.addAlias(secondary.id, `secondary-alias-${i}`);
    }

    await mem.mergeEntities(primary.id, secondary.id);

    const surviving = await store.getNode(primary.id);
    expect(surviving!.aliases).toHaveLength(10);
    // All 8 primary aliases are preserved
    for (let i = 0; i < 8; i++) {
      expect(surviving!.aliases).toContain(`primary-alias-${i}`);
    }
    // The first 2 secondary aliases fit; the last 3 are dropped
    expect(surviving!.aliases).toContain('secondary-alias-0');
    expect(surviving!.aliases).toContain('secondary-alias-1');
    expect(surviving!.aliases).not.toContain('secondary-alias-2');
    expect(surviving!.aliases).not.toContain('secondary-alias-3');
    expect(surviving!.aliases).not.toContain('secondary-alias-4');
  });

  it('leaves primary aliases unchanged when secondary has no aliases', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity: primary } = await mem.createEntity({
      type: 'person', label: 'Primary', properties: {}, source: 'test',
    });
    const { entity: secondary } = await mem.createEntity({
      type: 'person', label: 'Secondary', properties: {}, source: 'test',
    });
    await mem.addAlias(primary.id, 'p-alias');
    // secondary has no aliases

    await mem.mergeEntities(primary.id, secondary.id);

    const surviving = await store.getNode(primary.id);
    expect(surviving!.aliases).toEqual(['p-alias']);
  });
});

describe('EntityMemory.search — alias exact-match path', () => {
  it('surfaces a node via its stored alias with score 1.0', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });
    // The fake embedding for 'darlise' is completely different from 'Darlise Restaurant',
    // so this node won't appear via vector search alone.
    await mem.addAlias(entity.id, 'darlise');

    const results = await mem.search('darlise');

    expect(results.length).toBeGreaterThan(0);
    const match = results.find(r => r.node.id === entity.id);
    expect(match).toBeDefined();
    expect(match!.score).toBe(1.0);
  });

  it('returns an alias-matched node exactly once even when vector search also finds it', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });
    // Alias matches the canonical label (lower-cased) — findNodesByLabel and
    // semanticSearch will both return this node.
    await mem.addAlias(entity.id, 'darlise restaurant');

    const results = await mem.search('darlise restaurant');

    const matches = results.filter(r => r.node.id === entity.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.score).toBe(1.0);
  });

  it('excludes alias-matched nodes that do not match the type filter', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });
    await mem.addAlias(entity.id, 'darlise');

    // Search for type: 'person' — the organization node should not appear
    const results = await mem.search('darlise', { type: 'person' });

    expect(results.every(r => r.node.id !== entity.id)).toBe(true);
  });

  it('excludes alias-matched nodes above the sensitivity ceiling', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    // Create a restricted node directly via the store to set sensitivity
    const restrictedNode = await store.createNode({
      type: 'person',
      label: 'Private Person',
      properties: {},
      source: 'test',
      sensitivity: 'restricted',
    });
    // Add alias directly via store (EntityMemory.addAlias silently skips aliases
    // matching the canonical label; here we bypass that to set up the test alias)
    await store.addAlias(restrictedNode.id, 'private');

    // Create an internal node with the same alias — this one should appear
    const internalNode = await store.createNode({
      type: 'person',
      label: 'Internal Person',
      properties: {},
      source: 'test',
      sensitivity: 'internal',
    });
    await store.addAlias(internalNode.id, 'private');

    // Search with ceiling of 'internal' — 'restricted' is above that
    const results = await mem.search('private', { maxSensitivity: 'internal' });

    // Restricted node must not appear
    expect(results.every(r => r.node.id !== restrictedNode.id)).toBe(true);
    // Internal node must appear (positive assertion: filter allows valid nodes through)
    expect(results.some(r => r.node.id === internalNode.id)).toBe(true);
  });

  it('alias-matched nodes appear before lower-scoring vector results', async () => {
    const { mem } = makeEntityMemory();
    // Create two nodes: one with an exact alias match, one that may appear via embedding
    const { entity: aliasNode } = await mem.createEntity({
      type: 'person', label: 'Completely Unrelated Label XYZ', properties: {}, source: 'test',
    });
    await mem.addAlias(aliasNode.id, 'searchterm');

    await mem.createEntity({
      type: 'person', label: 'searchterm adjacent', properties: {}, source: 'test',
    });

    const results = await mem.search('searchterm', { limit: 10 });

    expect(results[0]!.node.id).toBe(aliasNode.id);
    expect(results[0]!.score).toBe(1.0);
    // Verify the secondary node (non-alias-matched) also appears via vector search
    expect(results.some(r => r.node.label === 'searchterm adjacent')).toBe(true);
  });
});
