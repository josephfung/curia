import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';

describe('MemoryValidator', () => {
  let store: KnowledgeGraphStore;
  let validator: MemoryValidator;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    store = KnowledgeGraphStore.createInMemory(embeddingService);
    validator = new MemoryValidator(store, embeddingService);
  });

  describe('deduplication', () => {
    it('detects duplicate fact by exact label match', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });
      // Create a fact and link it to the entity.
      // The dedup logic walks edges from the entity to find connected fact nodes —
      // without this edge, the validator can't discover the existing fact.
      const fact = await store.createNode({
        type: 'fact',
        label: 'Joseph lives in Kitchener',
        properties: {},
        source: 'test',
      });
      await store.createEdge({
        sourceNodeId: entity.id,
        targetNodeId: fact.id,
        type: 'relates_to',
        properties: {},
        source: 'test',
      });

      const result = await validator.validate({
        entityNodeId: entity.id,
        label: 'Joseph lives in Kitchener',
        source: 'test',
      });
      expect(result.action).toBe('update');
    });

    it('allows new fact when no duplicate exists', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      const result = await validator.validate({
        entityNodeId: entity.id,
        label: 'Joseph likes coffee',
        source: 'test',
      });
      expect(result.action).toBe('create');
    });

    it('returns merged properties on dedup hit', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      const fact = await store.createNode({
        type: 'fact',
        label: 'Joseph lives in Kitchener',
        properties: { verified: true },
        source: 'test',
      });
      await store.createEdge({
        sourceNodeId: entity.id,
        targetNodeId: fact.id,
        type: 'relates_to',
        properties: {},
        source: 'test',
      });

      const result = await validator.validate({
        entityNodeId: entity.id,
        label: 'Joseph lives in Kitchener',
        properties: { updatedBy: 'agent:coordinator' },
        source: 'test',
      });

      expect(result.action).toBe('update');
      if (result.action === 'update') {
        // Merged properties should contain both old and new fields
        expect(result.mergedProperties).toMatchObject({
          verified: true,
          updatedBy: 'agent:coordinator',
        });
      }
    });
  });

  describe('rate limiting', () => {
    it('rejects writes beyond the per-agent rate limit', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Test',
        properties: {},
        source: 'test',
      });

      const agentTaskKey = 'agent:test/task:task-1';
      // Record 50 writes to hit the limit exactly
      for (let i = 0; i < 50; i++) {
        validator.recordWrite(agentTaskKey);
      }

      const result = await validator.validate({
        entityNodeId: entity.id,
        label: 'One more fact',
        source: agentTaskKey,
      });
      expect(result.action).toBe('rejected');
      expect((result as { action: 'rejected'; reason: string }).reason).toContain('rate limit');
    });

    it('allows writes before the limit is reached', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Test',
        properties: {},
        source: 'test',
      });

      const agentTaskKey = 'agent:test/task:task-2';
      // Record 49 writes — one short of the limit
      for (let i = 0; i < 49; i++) {
        validator.recordWrite(agentTaskKey);
      }

      const result = await validator.validate({
        entityNodeId: entity.id,
        label: 'Still allowed',
        source: agentTaskKey,
      });
      expect(result.action).toBe('create');
    });

    it('resets rate limit counter after resetRateLimit()', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Test',
        properties: {},
        source: 'test',
      });

      const agentTaskKey = 'agent:test/task:task-3';
      for (let i = 0; i < 50; i++) {
        validator.recordWrite(agentTaskKey);
      }

      // Sanity check: should be blocked
      const blocked = await validator.validate({
        entityNodeId: entity.id,
        label: 'Blocked',
        source: agentTaskKey,
      });
      expect(blocked.action).toBe('rejected');

      // Reset and try again
      validator.resetRateLimit(agentTaskKey);
      const allowed = await validator.validate({
        entityNodeId: entity.id,
        label: 'Allowed after reset',
        source: agentTaskKey,
      });
      expect(allowed.action).toBe('create');
    });
  });

  describe('contradiction detection', () => {
    it('flags contradiction when existing fact has equal confidence', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      const existingFact = await store.createNode({
        type: 'fact',
        label: 'Joseph lives in Kitchener',
        properties: { attribute: 'location' },
        confidence: 0.8,
        source: 'test',
      });
      await store.createEdge({
        sourceNodeId: entity.id,
        targetNodeId: existingFact.id,
        type: 'relates_to',
        properties: {},
        source: 'test',
      });

      const result = await validator.validateContradiction({
        entityNodeId: entity.id,
        label: 'Joseph lives in Toronto',
        properties: { attribute: 'location' },
        confidence: 0.8,
        source: 'test',
      });

      expect(result.action).toBe('conflict');
    });

    it('includes existing and new fact labels in the conflict reason', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      const existingFact = await store.createNode({
        type: 'fact',
        label: 'Joseph lives in Kitchener',
        properties: { attribute: 'location' },
        confidence: 0.9,
        source: 'test',
      });
      await store.createEdge({
        sourceNodeId: entity.id,
        targetNodeId: existingFact.id,
        type: 'relates_to',
        properties: {},
        source: 'test',
      });

      const result = await validator.validateContradiction({
        entityNodeId: entity.id,
        label: 'Joseph lives in Vancouver',
        properties: { attribute: 'location' },
        confidence: 0.7,
        source: 'test',
      });

      expect(result.action).toBe('conflict');
      if (result.action === 'conflict') {
        expect(result.reason).toContain('Kitchener');
        expect(result.reason).toContain('Vancouver');
      }
    });

    it('proceeds normally when no contradiction exists for the attribute', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      // Existing fact has a DIFFERENT attribute, so no contradiction
      const existingFact = await store.createNode({
        type: 'fact',
        label: 'Joseph is 40 years old',
        properties: { attribute: 'age' },
        confidence: 0.9,
        source: 'test',
      });
      await store.createEdge({
        sourceNodeId: entity.id,
        targetNodeId: existingFact.id,
        type: 'relates_to',
        properties: {},
        source: 'test',
      });

      const result = await validator.validateContradiction({
        entityNodeId: entity.id,
        label: 'Joseph lives in Kitchener',
        properties: { attribute: 'location' },
        confidence: 0.8,
        source: 'test',
      });

      // Different attribute — no conflict, should produce a create
      expect(result.action).toBe('create');
    });

    it('falls through to normal validation when no attribute metadata present', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      // No attribute property — contradiction detection is skipped
      const result = await validator.validateContradiction({
        entityNodeId: entity.id,
        label: 'Joseph is a software engineer',
        confidence: 0.8,
        source: 'test',
      });

      expect(result.action).toBe('create');
    });
  });

  describe('source attribution', () => {
    it('records full provenance chain on validation result', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      const result = await validator.validate({
        entityNodeId: entity.id,
        label: 'New fact about Joseph',
        source: 'agent:coordinator/task:abc123/channel:cli',
      });

      expect(result.action).toBe('create');
      if (result.action === 'create') {
        expect(result.validated.temporal.source).toBe('agent:coordinator/task:abc123/channel:cli');
      }
    });

    it('preserves confidence and decayClass from options', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      const result = await validator.validate({
        entityNodeId: entity.id,
        label: 'Joseph is an executive',
        confidence: 0.95,
        decayClass: 'permanent',
        source: 'agent:coordinator/task:xyz/channel:email',
      });

      expect(result.action).toBe('create');
      if (result.action === 'create') {
        expect(result.validated.temporal.confidence).toBe(0.95);
        expect(result.validated.temporal.decayClass).toBe('permanent');
      }
    });

    it('defaults confidence to 0.7 and decayClass to slow_decay when omitted', async () => {
      const entity = await store.createNode({
        type: 'person',
        label: 'Joseph',
        properties: {},
        source: 'test',
      });

      const result = await validator.validate({
        entityNodeId: entity.id,
        label: 'Joseph has an office',
        source: 'test',
      });

      expect(result.action).toBe('create');
      if (result.action === 'create') {
        expect(result.validated.temporal.confidence).toBe(0.7);
        expect(result.validated.temporal.decayClass).toBe('slow_decay');
      }
    });
  });
});
