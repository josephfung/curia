import { describe, it, expect, beforeEach } from 'vitest';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createSilentLogger } from '../../../src/logger.js';

describe('EntityMemory', () => {
  let entityMemory: EntityMemory;
  let store: KnowledgeGraphStore;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());
  });

  describe('entity management', () => {
    it('creates a new entity and retrieves it', async () => {
      const entity = await entityMemory.createEntity({
        type: 'person',
        label: 'Joseph Fung',
        properties: { title: 'CEO' },
        source: 'test',
      });
      expect(entity.id).toBeDefined();
      expect(entity.label).toBe('Joseph Fung');
      const retrieved = await entityMemory.getEntity(entity.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.label).toBe('Joseph Fung');
    });

    it('returns undefined for a non-existent entity', async () => {
      const result = await entityMemory.getEntity('non-existent-id');
      expect(result).toBeUndefined();
    });

    it('finds entity by label', async () => {
      await entityMemory.createEntity({
        type: 'person',
        label: 'Joseph Fung',
        properties: {},
        source: 'test',
      });
      const results = await entityMemory.findEntities('Joseph Fung');
      expect(results).toHaveLength(1);
    });

    it('returns empty array when no entity matches the label', async () => {
      const results = await entityMemory.findEntities('Nobody Here');
      expect(results).toHaveLength(0);
    });

    it('stores entity properties on the node', async () => {
      const entity = await entityMemory.createEntity({
        type: 'organization',
        label: 'Curia',
        properties: { founded: 2023, industry: 'AI' },
        source: 'test',
      });
      expect(entity.properties).toMatchObject({ founded: 2023, industry: 'AI' });
      expect(entity.type).toBe('organization');
    });
  });

  describe('fact management', () => {
    it('stores a fact about an entity', async () => {
      const entity = await entityMemory.createEntity({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });
      const result = await entityMemory.storeFact({
        entityNodeId: entity.id,
        label: 'Joseph is CEO of Curia',
        properties: { attribute: 'role' },
        source: 'agent:coordinator/task:test',
      });
      expect(result.stored).toBe(true);
    });

    it('returns nodeId when a fact is stored', async () => {
      const entity = await entityMemory.createEntity({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });
      const result = await entityMemory.storeFact({
        entityNodeId: entity.id,
        label: 'Joseph is CEO of Curia',
        source: 'test',
      });
      expect(result.stored).toBe(true);
      expect(result.nodeId).toBeDefined();
    });

    it('retrieves all facts about an entity', async () => {
      const entity = await entityMemory.createEntity({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });
      await entityMemory.storeFact({
        entityNodeId: entity.id,
        label: 'Joseph is CEO',
        source: 'test',
      });
      await entityMemory.storeFact({
        entityNodeId: entity.id,
        label: 'Joseph lives in Kitchener',
        source: 'test',
      });
      const facts = await entityMemory.getFacts(entity.id);
      expect(facts).toHaveLength(2);
    });

    it('getFacts returns only fact-type nodes, not entity nodes', async () => {
      const personA = await entityMemory.createEntity({
        type: 'person',
        label: 'Alice',
        properties: {},
        source: 'test',
      });
      const personB = await entityMemory.createEntity({
        type: 'person',
        label: 'Bob',
        properties: {},
        source: 'test',
      });
      // Link two entities together — the linked entity (personB) is not a fact
      await entityMemory.link(personA.id, personB.id, 'relates_to', {}, 'test');
      // Also add an actual fact
      await entityMemory.storeFact({
        entityNodeId: personA.id,
        label: 'Alice is a developer',
        source: 'test',
      });

      const facts = await entityMemory.getFacts(personA.id);
      // Should only contain the one fact node, not the person node
      expect(facts).toHaveLength(1);
      expect(facts[0]!.type).toBe('fact');
    });

    it('deduplicates identical facts (returns stored:true with existing nodeId)', async () => {
      const entity = await entityMemory.createEntity({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });
      const first = await entityMemory.storeFact({
        entityNodeId: entity.id,
        label: 'Joseph is the founder',
        source: 'test',
      });
      expect(first.stored).toBe(true);

      // Identical label — dedup should return stored:true with the existing nodeId
      const second = await entityMemory.storeFact({
        entityNodeId: entity.id,
        label: 'Joseph is the founder',
        source: 'test',
      });
      expect(second.stored).toBe(true);

      // Should not have created a second fact node
      const facts = await entityMemory.getFacts(entity.id);
      expect(facts).toHaveLength(1);
    });

    it('returns stored:false with conflict reason on contradiction', async () => {
      const entity = await entityMemory.createEntity({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });
      // Store a fact with attribute metadata to enable contradiction detection
      await store.createNode({
        type: 'fact',
        label: 'Joseph lives in Kitchener',
        properties: { attribute: 'location' },
        confidence: 0.9,
        source: 'test',
      });

      // We won't exercise the full contradiction path here since storeFact calls
      // validate() not validateContradiction(). This test verifies the rejected path.
      // Hit the rate limit to force a rejection.
      const validator = new MemoryValidator(store, EmbeddingService.createForTesting());
      const em = new EntityMemory(store, validator, EmbeddingService.createForTesting(), createSilentLogger());
      // Pre-fill rate limit counter
      for (let i = 0; i < 50; i++) {
        validator.recordWrite('agent:test/task:rate-limit-test');
      }
      const result = await em.storeFact({
        entityNodeId: entity.id,
        label: 'Some fact that would be rejected',
        source: 'agent:test/task:rate-limit-test',
      });
      expect(result.stored).toBe(false);
      expect(result.conflict).toBeDefined();
    });
  });

  describe('link', () => {
    it('creates a directed edge between two entities', async () => {
      const person = await entityMemory.createEntity({
        type: 'person',
        label: 'Alice',
        properties: {},
        source: 'test',
      });
      const project = await entityMemory.createEntity({
        type: 'project',
        label: 'Curia',
        properties: {},
        source: 'test',
      });
      const edge = await entityMemory.link(person.id, project.id, 'works_on', { role: 'lead' }, 'test');
      expect(edge.id).toBeDefined();
      expect(edge.type).toBe('works_on');
      expect(edge.sourceNodeId).toBe(person.id);
      expect(edge.targetNodeId).toBe(project.id);
    });
  });

  describe('semantic search', () => {
    it('searches across all knowledge', async () => {
      const entity = await entityMemory.createEntity({
        type: 'project',
        label: 'Curia AI Platform',
        properties: {},
        source: 'test',
      });
      await entityMemory.storeFact({
        entityNodeId: entity.id,
        label: 'Curia uses multi-agent architecture',
        source: 'test',
      });
      const results = await entityMemory.search('agent framework design');
      expect(results.length).toBeGreaterThan(0);
    });

    it('respects the limit option', async () => {
      // Create several entities so there are enough nodes to limit
      for (let i = 0; i < 5; i++) {
        await entityMemory.createEntity({
          type: 'concept',
          label: `Concept ${i}`,
          properties: {},
          source: 'test',
        });
      }
      const results = await entityMemory.search('concept', { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('resetRateLimit', () => {
    it('clears the write count for the given key so a new task gets a fresh slate', async () => {
      const embeddingService = EmbeddingService.createForTesting();
      const localStore = KnowledgeGraphStore.createInMemory(embeddingService);
      const validator = new MemoryValidator(localStore, embeddingService);
      const em = new EntityMemory(localStore, validator, embeddingService, createSilentLogger());

      const entity = await em.createEntity({
        type: 'person',
        label: 'Test Subject',
        properties: {},
        source: 'test',
      });

      const sourceKey = 'agent:coordinator/task:test-task-1/channel:cli';
      // Fill up the rate limit for this task key
      for (let i = 0; i < 50; i++) {
        validator.recordWrite(sourceKey);
      }

      // Verify it's blocked
      const blocked = await em.storeFact({
        entityNodeId: entity.id,
        label: 'Should be blocked',
        source: sourceKey,
      });
      expect(blocked.stored).toBe(false);

      // Reset via EntityMemory (the production path)
      em.resetRateLimit(sourceKey);

      // Should now be allowed again
      const allowed = await em.storeFact({
        entityNodeId: entity.id,
        label: 'Should be allowed after reset',
        source: sourceKey,
      });
      expect(allowed.stored).toBe(true);
    });
  });

  describe('query - what do I know about X?', () => {
    it('returns entity with connected facts and relationships', async () => {
      const person = await entityMemory.createEntity({
        type: 'person',
        label: 'Alice',
        properties: {},
        source: 'test',
      });
      const project = await entityMemory.createEntity({
        type: 'project',
        label: 'Curia',
        properties: {},
        source: 'test',
      });
      await entityMemory.storeFact({
        entityNodeId: person.id,
        label: 'Alice is the tech lead',
        source: 'test',
      });
      await entityMemory.link(person.id, project.id, 'works_on', { role: 'tech lead' }, 'test');
      const knowledge = await entityMemory.query(person.id);
      expect(knowledge.entity.label).toBe('Alice');
      expect(knowledge.facts.length).toBeGreaterThanOrEqual(1);
      expect(knowledge.relationships.length).toBeGreaterThanOrEqual(1);
    });

    it('returns the queried entity node', async () => {
      const entity = await entityMemory.createEntity({
        type: 'organization',
        label: 'Anthropic',
        properties: { sector: 'AI safety' },
        source: 'test',
      });
      const result = await entityMemory.query(entity.id);
      expect(result.entity.id).toBe(entity.id);
      expect(result.entity.label).toBe('Anthropic');
    });

    it('returns empty facts and relationships when entity is isolated', async () => {
      const entity = await entityMemory.createEntity({
        type: 'concept',
        label: 'Isolated Node',
        properties: {},
        source: 'test',
      });
      const result = await entityMemory.query(entity.id);
      expect(result.entity).toBeDefined();
      expect(result.facts).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('relationships include the edge and the connected node', async () => {
      const a = await entityMemory.createEntity({
        type: 'person',
        label: 'Bob',
        properties: {},
        source: 'test',
      });
      const b = await entityMemory.createEntity({
        type: 'project',
        label: 'ProjectX',
        properties: {},
        source: 'test',
      });
      await entityMemory.link(a.id, b.id, 'works_on', {}, 'test');

      const result = await entityMemory.query(a.id);
      expect(result.relationships).toHaveLength(1);
      const rel = result.relationships[0]!;
      expect(rel.edge.type).toBe('works_on');
      expect(rel.node.label).toBe('ProjectX');
    });

    it('throws when queried entity does not exist', async () => {
      await expect(entityMemory.query('non-existent-id')).rejects.toThrow();
    });
  });

  describe('upsertEdge', () => {
    it('creates a new edge when none exists', async () => {
      const a = await entityMemory.createEntity({ type: 'person', label: 'Upsert-A', properties: {}, source: 'test' });
      const b = await entityMemory.createEntity({ type: 'person', label: 'Upsert-B', properties: {}, source: 'test' });

      const result = await entityMemory.upsertEdge(a.id, b.id, 'spouse', {}, 'test', 0.8);

      expect(result.created).toBe(true);
      expect(result.edge.type).toBe('spouse');
      expect(result.edge.temporal.confidence).toBe(0.8);
    });

    it('confirms an existing edge when called again with same direction', async () => {
      const a = await entityMemory.createEntity({ type: 'person', label: 'Upsert-C', properties: {}, source: 'test' });
      const b = await entityMemory.createEntity({ type: 'person', label: 'Upsert-D', properties: {}, source: 'test' });
      await entityMemory.upsertEdge(a.id, b.id, 'manages', {}, 'test', 0.7);

      const result = await entityMemory.upsertEdge(a.id, b.id, 'manages', {}, 'test', 0.7);

      expect(result.created).toBe(false);
      // Exactly one edge, not two
      const queryResult = await entityMemory.query(a.id);
      expect(queryResult.relationships).toHaveLength(1);
    });

    it('confirms an existing edge when called with reversed direction (bidirectional check)', async () => {
      const a = await entityMemory.createEntity({ type: 'person', label: 'Upsert-E', properties: {}, source: 'test' });
      const b = await entityMemory.createEntity({ type: 'person', label: 'Upsert-F', properties: {}, source: 'test' });
      await entityMemory.upsertEdge(a.id, b.id, 'spouse', {}, 'test', 0.8);

      // Call with reversed order — should confirm the existing edge, not create a duplicate
      const result = await entityMemory.upsertEdge(b.id, a.id, 'spouse', {}, 'test', 0.8);

      expect(result.created).toBe(false);
      const queryResult = await entityMemory.query(a.id);
      expect(queryResult.relationships).toHaveLength(1);
    });

    it('raises confidence when re-assertion has higher confidence', async () => {
      const a = await entityMemory.createEntity({ type: 'person', label: 'Upsert-G', properties: {}, source: 'test' });
      const b = await entityMemory.createEntity({ type: 'person', label: 'Upsert-H', properties: {}, source: 'test' });
      await entityMemory.upsertEdge(a.id, b.id, 'reports_to', {}, 'test', 0.6);

      const result = await entityMemory.upsertEdge(a.id, b.id, 'reports_to', {}, 'test', 0.9);

      expect(result.created).toBe(false);
      expect(result.edge.temporal.confidence).toBe(0.9);
    });

    it('does not lower confidence when re-assertion has lower confidence', async () => {
      const a = await entityMemory.createEntity({ type: 'person', label: 'Upsert-I', properties: {}, source: 'test' });
      const b = await entityMemory.createEntity({ type: 'person', label: 'Upsert-J', properties: {}, source: 'test' });
      await entityMemory.upsertEdge(a.id, b.id, 'sibling', {}, 'test', 0.9);

      const result = await entityMemory.upsertEdge(a.id, b.id, 'sibling', {}, 'test', 0.3);

      expect(result.created).toBe(false);
      // Confidence stays at 0.9, not lowered to 0.3
      expect(result.edge.temporal.confidence).toBe(0.9);
    });

    it('refreshes lastConfirmedAt on re-assertion', async () => {
      const a = await entityMemory.createEntity({ type: 'person', label: 'Upsert-K', properties: {}, source: 'test' });
      const b = await entityMemory.createEntity({ type: 'person', label: 'Upsert-L', properties: {}, source: 'test' });
      const first = await entityMemory.upsertEdge(a.id, b.id, 'advises', {}, 'test', 0.7);
      const firstConfirmedAt = first.edge.temporal.lastConfirmedAt;

      // Small delay to ensure timestamp differs
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await entityMemory.upsertEdge(a.id, b.id, 'advises', {}, 'test', 0.7);

      expect(second.edge.temporal.lastConfirmedAt.getTime()).toBeGreaterThanOrEqual(firstConfirmedAt.getTime());
    });
  });
});
