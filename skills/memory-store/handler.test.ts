// handler.test.ts — memory-store skill unit tests.
//
// Uses real EntityMemory (backed by in-memory KG store) for entity resolution
// and the full created/conflict pipeline. Uses a mock entityMemory stub for
// the updated, rate_limited, and entity_not_found outcomes, which require state that is hard to
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

// Factory for mock entity memory objects used in the updated/rate_limited/entity_not_found tests.
// The resolveOrCreate mock always resolves to a known entity; storeFact behaviour is injected.
function makeMockEntityMemory(storeFactResult: Record<string, unknown>) {
  return {
    resolveOrCreate: vi.fn().mockResolvedValue({
      kind: 'found',
      node: { id: 'entity-1', label: 'Jane Doe', type: 'person' },
    }),
    storeFact: vi.fn().mockResolvedValue(storeFactResult),
  };
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
    it('auto-creates entity when label is not found and stores the fact', async () => {
      // resolveOrCreate creates the entity automatically — no pre-existing node needed
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, VALID_INPUT));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
    });

    it('uses entity_type when auto-creating a new entity', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, {
        ...VALID_INPUT,
        entity: 'Q3 Budget',
        entity_type: 'project',
      }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');

      // Verify the auto-created node has the specified type
      const nodes = await mem.findEntities('Q3 Budget');
      expect(nodes[0]?.type).toBe('project');
    });

    it('resolves entity by direct UUID when passed a node ID', async () => {
      const { mem } = makeEntityMemory();
      const { entity } = await mem.createEntity({
        type: 'person', label: 'Jane Doe', properties: {}, source: 'test',
      });

      // Pass the UUID directly — bypasses label lookup, goes through getEntity()
      const result = await handler.execute(makeCtx(mem, { ...VALID_INPUT, entity: entity.id }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
    });

    it('returns entity_not_found when a UUID entity no longer exists', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, {
        ...VALID_INPUT,
        entity: '00000000-0000-0000-0000-000000000000',
      }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('entity_not_found');
    });

    it('returns ambiguous when multiple nodes share the same label with no type match', async () => {
      const { mem, store } = makeEntityMemory();
      // Insert two nodes with the same label via the store to bypass upsert
      await store.createNode({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });
      await store.createNode({ type: 'organization', label: 'Jane Doe', properties: {}, source: 'test' });

      // No type hint provided — falls back to 'concept', which doesn't match either
      const result = await handler.execute(makeCtx(mem, VALID_INPUT));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { ambiguous: boolean; candidates: unknown[] } }).data;
      expect(data.ambiguous).toBe(true);
      expect(data.candidates).toHaveLength(2);
    });

    it('rejects unknown entity_type', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { ...VALID_INPUT, entity_type: 'spaceship' }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/entity_type/i);
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

  // ── Mocked entityMemory for updated / rate_limited / entity_not_found outcomes ───

  describe('action: updated', () => {
    it('returns updated with node_id and sensitivity when storeFact detects a near-duplicate', async () => {
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: makeMockEntityMemory({ stored: true, action: 'updated', nodeId: 'fact-existing-42', sensitivity: 'internal' }),
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

  describe('memoryWriteSource', () => {
    it('uses memoryWriteSource as the storeFact source when available on context', async () => {
      const mockMem = makeMockEntityMemory({ stored: true, action: 'created', nodeId: 'fact-1' });
      const memoryWriteSource = 'agent:ceo-inbox/task:task-abc/channel:internal';
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockMem,
        memoryWriteSource,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      // storeFact should have been called with the context-aware source, not the LLM-provided one
      expect(mockMem.storeFact).toHaveBeenCalledTimes(1);
      expect(mockMem.storeFact.mock.calls[0]![0].source).toBe(memoryWriteSource);
    });

    it('falls back to LLM-provided source when memoryWriteSource is not set', async () => {
      const mockMem = makeMockEntityMemory({ stored: true, action: 'created', nodeId: 'fact-1' });
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockMem,
        // No memoryWriteSource — simulates test / CLI invocations
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      // Should fall back to the LLM-provided source from VALID_INPUT
      expect(mockMem.storeFact.mock.calls[0]![0].source).toBe(VALID_INPUT.source);
    });
  });

  describe('action: rate_limited', () => {
    it('returns rate_limited with reason when storeFact hits the write limit', async () => {
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: makeMockEntityMemory({ stored: false, action: 'rate_limited', conflict: 'Memory write rate limit exceeded (50 per agent per task)' }),
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('rate_limited');
      expect(String(data.reason)).toMatch(/rate limit/i);
    });
  });

  describe('action: entity_not_found (validator race)', () => {
    it('returns entity_not_found when storeFact reports entity gone at write time', async () => {
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: makeMockEntityMemory({ stored: false, action: 'entity_not_found', conflict: 'Entity node not found: entity-1' }),
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('entity_not_found');
      expect(String(data.reason)).toMatch(/entity node not found/i);
    });
  });

  describe('action: auto_rejected', () => {
    it('returns auto_rejected with reason and existing_node_id when incoming fact has lower confidence', async () => {
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: makeMockEntityMemory({
          stored: false,
          action: 'auto_rejected',
          conflict: 'Existing fact "location: Kitchener" (confidence: 0.9) has higher confidence than incoming "location: Toronto" (confidence: 0.7) — write rejected',
          existingNodeId: 'existing-node-123',
        }),
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('auto_rejected');
      expect(String(data.reason)).toMatch(/Kitchener/);
      expect(data.existing_node_id).toBe('existing-node-123');
    });
  });

  describe('action: auto_resolved', () => {
    it('returns auto_resolved with node_id and sensitivity when incoming fact has higher confidence and replaces the existing one', async () => {
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: makeMockEntityMemory({
          stored: true,
          action: 'auto_resolved',
          nodeId: 'existing-node-123',
          sensitivity: 'internal',
        }),
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('auto_resolved');
      expect(data.node_id).toBe('existing-node-123');
      expect(data.sensitivity).toBe('internal');
    });
  });

  // ── Canonical contact attribute redirect ─────────────────────────────────

  describe('action: redirected_to_contact', () => {
    function makeCtxWithContact(
      entityMemory: ReturnType<typeof makeMockEntityMemory>,
      contact: { id: string } | null,
      input: Record<string, unknown>,
    ): SkillContext {
      const contactService = {
        findContactByKgNodeId: vi.fn().mockResolvedValue(contact),
        updateContactFields: vi.fn().mockResolvedValue({ id: contact?.id ?? 'c1' }),
      };
      return {
        input,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory,
        contactService,
      } as unknown as SkillContext;
    }

    it('redirects a canonical attribute write to ContactService when entity is a person with a contact', async () => {
      const mockMem = {
        ...makeMockEntityMemory({}),
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'kg-1', label: 'Jane Doe', type: 'person' },
        }),
        // storeFact should NOT be called — the guard short-circuits
        storeFact: vi.fn().mockRejectedValue(new Error('storeFact should not be called')),
      };
      const ctx = makeCtxWithContact(
        mockMem,
        { id: 'contact-1' },
        { entity: 'Jane Doe', field: 'timezone', value: 'America/Toronto', source: 'test' },
      );

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('redirected_to_contact');
      expect(data.contact_id).toBe('contact-1');
      // storeFact must not have been called
      expect(mockMem.storeFact).not.toHaveBeenCalled();
      // updateContactFields should have been called with the canonical field
      const cs = (ctx as unknown as { contactService: { updateContactFields: ReturnType<typeof vi.fn> } }).contactService;
      expect(cs.updateContactFields).toHaveBeenCalledWith('contact-1', { timezone: 'America/Toronto' });
    });

    it('normalizes phone numbers to E.164 before redirecting', async () => {
      const mockMem = {
        ...makeMockEntityMemory({}),
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'kg-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockRejectedValue(new Error('storeFact should not be called')),
      };
      const ctx = makeCtxWithContact(
        mockMem,
        { id: 'contact-1' },
        { entity: 'Jane Doe', field: 'phone', value: '(416) 555-1234', source: 'test' },
      );

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.action).toBe('redirected_to_contact');
      const cs = (ctx as unknown as { contactService: { updateContactFields: ReturnType<typeof vi.fn> } }).contactService;
      expect(cs.updateContactFields).toHaveBeenCalledWith('contact-1', { primaryPhone: '+14165551234' });
    });

    it('falls back to KG write when phone cannot be normalized to E.164', async () => {
      const mockMem = {
        ...makeMockEntityMemory({}),
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'kg-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created', nodeId: 'fact-1', sensitivity: 'internal' }),
      };
      const ctx = makeCtxWithContact(
        mockMem,
        { id: 'contact-1' },
        { entity: 'Jane Doe', field: 'phone', value: 'not-a-phone-number', source: 'test' },
      );

      const result = await handler.execute(ctx);

      // Falls through to KG write because normalization failed
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
      expect(mockMem.storeFact).toHaveBeenCalledTimes(1);
    });

    it('falls back to KG write when findContactByKgNodeId throws (DB error)', async () => {
      const mockMem = {
        ...makeMockEntityMemory({}),
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'kg-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created', nodeId: 'fact-1', sensitivity: 'internal' }),
      };
      const contactService = {
        findContactByKgNodeId: vi.fn().mockRejectedValue(new Error('connection timeout')),
        updateContactFields: vi.fn().mockRejectedValue(new Error('should not be called')),
      };
      const ctx = {
        input: { entity: 'Jane Doe', field: 'timezone', value: 'America/Toronto', source: 'test' },
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockMem,
        contactService,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      // DB error during contact lookup → falls through to KG write, not a skill error
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(mockMem.storeFact).toHaveBeenCalledTimes(1);
      expect(contactService.updateContactFields).not.toHaveBeenCalled();
    });

    it('falls through to KG write when person node has no contact record', async () => {
      const mockMem = {
        ...makeMockEntityMemory({}),
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'kg-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created', nodeId: 'fact-1', sensitivity: 'internal' }),
      };
      // contact is null — person KG node with no linked contact row
      const ctx = makeCtxWithContact(
        mockMem,
        null,
        { entity: 'Jane Doe', field: 'timezone', value: 'America/Toronto', source: 'test' },
      );

      const result = await handler.execute(ctx);

      // No contact → falls through to KG write
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(mockMem.storeFact).toHaveBeenCalledTimes(1);
    });

    it('does not redirect non-person entity types', async () => {
      const mockMem = {
        ...makeMockEntityMemory({}),
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'kg-org-1', label: 'Acme Corp', type: 'organization' },
        }),
        storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created', nodeId: 'fact-1', sensitivity: 'internal' }),
      };
      const ctx = makeCtxWithContact(
        mockMem,
        { id: 'contact-1' },
        { entity: 'Acme Corp', field: 'timezone', value: 'America/Toronto', source: 'test' },
      );

      const result = await handler.execute(ctx);

      // organization entity → no redirect
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(mockMem.storeFact).toHaveBeenCalledTimes(1);
    });

    it('does not redirect non-canonical attributes', async () => {
      const mockMem = {
        ...makeMockEntityMemory({}),
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'kg-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created', nodeId: 'fact-1', sensitivity: 'internal' }),
      };
      const ctx = makeCtxWithContact(
        mockMem,
        { id: 'contact-1' },
        { entity: 'Jane Doe', field: 'preferred_airline', value: 'Air Canada', source: 'test' },
      );

      const result = await handler.execute(ctx);

      // preferred_airline is not canonical → goes to KG
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(mockMem.storeFact).toHaveBeenCalledTimes(1);
    });

    it('returns success:false when ContactService.updateContactFields throws a validation error', async () => {
      const mockMem = {
        ...makeMockEntityMemory({}),
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'kg-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockRejectedValue(new Error('should not be called')),
      };
      const contactService = {
        findContactByKgNodeId: vi.fn().mockResolvedValue({ id: 'contact-1' }),
        updateContactFields: vi.fn().mockRejectedValue(new Error("primaryEmail not found in contact_channel_identities")),
      };
      const ctx = {
        input: { entity: 'Jane Doe', field: 'primary_email', value: 'jane@example.com', source: 'test' },
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockMem,
        contactService,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/primaryEmail/i);
    });
  });

  // ── Infrastructure error handling ─────────────────────────────────────────

  describe('error handling', () => {
    it('returns success:false when storeFact throws unexpectedly', async () => {
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: {
          ...makeMockEntityMemory({}),
          storeFact: vi.fn().mockRejectedValue(new Error('DB connection lost')),
        },
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toContain('DB connection lost');
    });
  });
});
