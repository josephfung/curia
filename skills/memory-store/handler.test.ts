// handler.test.ts — memory-store skill unit tests.
//
// Uses real EntityMemory (backed by in-memory KG store) for entity resolution
// and the full created/conflict pipeline. Uses a mock entityMemory stub for
// the updated and rejected outcomes, which require state that is hard to
// construct reliably with the in-memory backend.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { MemoryStoreHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeEntityMemory() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return { mem: new EntityMemory(store, validator, embeddingService, createSilentLogger()), store };
}

function makeCtx(entityMemory: EntityMemory | undefined, input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: () => 'test-key',
    log: pino({ level: 'silent' }),
    entityMemory,
  } as unknown as SkillContext;
}

const VALID_INPUT = {
  entity: 'Jane Doe',
  field: 'preferred_airline',
  value: 'Air Canada',
  source: 'agent:coordinator/task:test123',
};

describe('MemoryStoreHandler', () => {
  const handler = new MemoryStoreHandler();

  // ── Input validation ──────────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects missing entity', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { field: 'role', value: 'CEO', source: 's' }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/entity/i);
    });

    it('rejects missing field', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { entity: 'Jane', value: 'CEO', source: 's' }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/field/i);
    });

    it('rejects missing value', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { entity: 'Jane', field: 'role', source: 's' }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/value/i);
    });

    it('rejects missing source', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { entity: 'Jane', field: 'role', value: 'CEO' }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/source/i);
    });

    it('rejects confidence out of range', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { ...VALID_INPUT, confidence: 1.5 }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/confidence/i);
    });

    it('rejects an unknown decay_class', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { ...VALID_INPUT, decay_class: 'eternal' }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/decay_class/i);
    });

    it('rejects an unknown sensitivity value', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { ...VALID_INPUT, sensitivity: 'top_secret' }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/sensitivity/i);
    });

    it('rejects when entityMemory is not available', async () => {
      const result = await handler.execute(makeCtx(undefined, VALID_INPUT));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/entity memory not available/i);
    });
  });

  // ── Entity resolution ─────────────────────────────────────────────────────

  describe('entity resolution', () => {
    it('returns rejected when entity label is not found', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, VALID_INPUT));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('rejected');
      expect(String(data.reason)).toMatch(/not found/i);
    });

    it('resolves entity by direct node ID when label lookup finds nothing', async () => {
      const { mem } = makeEntityMemory();
      const { entity } = await mem.createEntity({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });

      // Pass the UUID directly instead of the label
      const result = await handler.execute(makeCtx(mem, { ...VALID_INPUT, entity: entity.id }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
    });

    it('returns ambiguous when multiple nodes share the same label', async () => {
      // KG upsert prevents duplicates via createEntity — insert a second node
      // directly through the store to simulate pre-migration duplicates.
      const { mem, store } = makeEntityMemory();
      await mem.createEntity({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });
      await store.createNode({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });

      const result = await handler.execute(makeCtx(mem, VALID_INPUT));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { ambiguous: boolean; candidates: unknown[] } }).data;
      expect(data.ambiguous).toBe(true);
      expect(data.candidates).toHaveLength(2);
    });
  });

  // ── Successful fact storage ───────────────────────────────────────────────

  describe('action: created', () => {
    it('stores a new fact and returns created with node_id and sensitivity', async () => {
      const { mem } = makeEntityMemory();
      await mem.createEntity({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });

      const result = await handler.execute(makeCtx(mem, VALID_INPUT));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
      expect(typeof data.node_id).toBe('string');
      // Sensitivity defaults to 'internal' without a classifier configured
      expect(data.sensitivity).toBe('internal');
    });

    it('accepts all optional inputs and passes them through', async () => {
      const { mem } = makeEntityMemory();
      await mem.createEntity({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });

      const result = await handler.execute(makeCtx(mem, {
        ...VALID_INPUT,
        confidence: 0.95,
        decay_class: 'permanent',
        sensitivity: 'confidential',
        sensitivity_category: 'financial',
      }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
      // Explicit sensitivity should be honoured
      expect(data.sensitivity).toBe('confidential');
    });
  });

  describe('action: conflict', () => {
    it('returns conflict with reason and existing_node_id when facts contradict', async () => {
      const { mem } = makeEntityMemory();
      await mem.createEntity({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });

      // Store initial fact
      await handler.execute(makeCtx(mem, {
        ...VALID_INPUT,
        field: 'home_city',
        value: 'Toronto',
      }));

      // Store contradicting fact for same attribute
      const result = await handler.execute(makeCtx(mem, {
        ...VALID_INPUT,
        field: 'home_city',
        value: 'Montreal',
      }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('conflict');
      expect(typeof data.reason).toBe('string');
      // existing_node_id lets the caller surface the contradicting node to the CEO
      expect(typeof data.existing_node_id).toBe('string');
    });
  });

  // ── Mocked entityMemory for updated / rejected outcomes ───────────────────

  describe('action: updated', () => {
    it('returns updated with node_id and sensitivity when storeFact detects a near-duplicate', async () => {
      const mockEntityMemory = {
        findEntities: vi.fn().mockResolvedValue([{ id: 'entity-1', label: 'Jane Doe', type: 'person' }]),
        getEntity: vi.fn(),
        storeFact: vi.fn().mockResolvedValue({
          stored: true,
          action: 'updated',
          nodeId: 'fact-existing-42',
          sensitivity: 'internal',
        }),
      };
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockEntityMemory,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('updated');
      expect(data.node_id).toBe('fact-existing-42');
      expect(data.sensitivity).toBe('internal');
    });
  });

  describe('action: rejected', () => {
    it('returns rejected with reason when storeFact reports rate-limit or entity-gone', async () => {
      const mockEntityMemory = {
        findEntities: vi.fn().mockResolvedValue([{ id: 'entity-1', label: 'Jane Doe', type: 'person' }]),
        getEntity: vi.fn(),
        storeFact: vi.fn().mockResolvedValue({
          stored: false,
          action: 'rejected',
          conflict: 'Memory write rate limit exceeded (50 per agent per task)',
        }),
      };
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockEntityMemory,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('rejected');
      expect(String(data.reason)).toMatch(/rate limit/i);
    });
  });

  // ── Infrastructure error handling ─────────────────────────────────────────

  describe('error handling', () => {
    it('returns success:false when storeFact throws unexpectedly', async () => {
      const mockEntityMemory = {
        findEntities: vi.fn().mockResolvedValue([{ id: 'entity-1', label: 'Jane Doe', type: 'person' }]),
        getEntity: vi.fn(),
        storeFact: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      };
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockEntityMemory,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toContain('DB connection lost');
    });
  });
});
