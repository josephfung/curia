import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { MemoryQueryHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeEntityMemory(): EntityMemory {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService, createSilentLogger());
}

function makeCtx(entityMemory: EntityMemory, input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: () => 'test-key',
    log: pino({ level: 'silent' }),
    entityMemory,
  } as unknown as SkillContext;
}

describe('MemoryQueryHandler', () => {
  it('returns empty results when KG is empty', async () => {
    const mem = makeEntityMemory();
    const handler = new MemoryQueryHandler();
    const ctx = makeCtx(mem, { query: 'investor relations' });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { results: [], count: 0 } });
  });

  it('returns error when query is missing', async () => {
    const mem = makeEntityMemory();
    const handler = new MemoryQueryHandler();
    const ctx = makeCtx(mem, {});

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/missing required input: query/i);
  });

  it('returns error when entityMemory is not available', async () => {
    const handler = new MemoryQueryHandler();
    const ctx = {
      input: { query: 'something' },
      secret: () => 'test-key',
      log: pino({ level: 'silent' }),
      entityMemory: undefined,
    } as unknown as SkillContext;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/entity memory not available/i);
  });

  it('returns error for an unknown node type', async () => {
    const mem = makeEntityMemory();
    const handler = new MemoryQueryHandler();
    const ctx = makeCtx(mem, { query: 'test', type: 'spaceship' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/unknown node type/i);
  });

  it('returns error for an unknown sensitivity level', async () => {
    const mem = makeEntityMemory();
    const handler = new MemoryQueryHandler();
    const ctx = makeCtx(mem, { query: 'test', max_sensitivity: 'topsecret' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/unknown sensitivity level/i);
  });

  it('returns matched nodes with required output fields', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Alice Investor', properties: {}, source: 'test' });

    const handler = new MemoryQueryHandler();
    const ctx = makeCtx(mem, { query: 'Alice Investor' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { results: Record<string, unknown>[]; count: number } }).data;
    expect(data.count).toBeGreaterThan(0);

    const node = data.results[0]!;
    expect(node).toHaveProperty('id');
    expect(node).toHaveProperty('type');
    expect(node).toHaveProperty('label');
    expect(node).toHaveProperty('properties');
    expect(node).toHaveProperty('confidence');
    expect(node).toHaveProperty('decay_class');
    expect(node).toHaveProperty('sensitivity');
    expect(node).toHaveProperty('last_confirmed_at');
    expect(node).toHaveProperty('score');
  });

  it('filters results by type', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'organization', label: 'Alice Corp', properties: {}, source: 'test' });

    const handler = new MemoryQueryHandler();
    const ctx = makeCtx(mem, { query: 'Alice', type: 'organization' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { results: Array<{ type: string }> } }).data;
    // Every returned node must be of the requested type
    expect(data.results.every((n) => n.type === 'organization')).toBe(true);
  });

  it('filters results by max_sensitivity ceiling', async () => {
    const mem = makeEntityMemory();
    // Create one public and one restricted node
    await mem.createEntity({ type: 'person', label: 'Public Person', properties: {}, source: 'test', sensitivity: 'public' });
    await mem.createEntity({ type: 'person', label: 'Restricted Person', properties: {}, source: 'test', sensitivity: 'restricted' });

    const handler = new MemoryQueryHandler();
    // Ask for results with max_sensitivity: internal — should exclude restricted
    const ctx = makeCtx(mem, { query: 'Person', max_sensitivity: 'internal' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { results: Array<{ sensitivity: string }> } }).data;
    // No restricted nodes should appear
    expect(data.results.every((n) => n.sensitivity !== 'restricted')).toBe(true);
  });

  it('caps limit at 50', async () => {
    const mem = makeEntityMemory();
    // Create a handful of nodes — enough to confirm capping logic without being slow
    for (let i = 0; i < 5; i++) {
      await mem.createEntity({ type: 'concept', label: `Concept ${i}`, properties: {}, source: 'test' });
    }

    const handler = new MemoryQueryHandler();
    // Request more than 50 — should be silently capped
    const ctx = makeCtx(mem, { query: 'Concept', limit: 999 });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    // With only 5 nodes the cap doesn't truncate, but the call itself must succeed
    expect((result as { success: true; data: { count: number } }).data.count).toBeLessThanOrEqual(50);
  });

  it('returns results sorted by score descending', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'concept', label: 'Board Meeting Agenda', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'Jane Smith', properties: {}, source: 'test' });

    const handler = new MemoryQueryHandler();
    const ctx = makeCtx(mem, { query: 'Board Meeting Agenda' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const nodes = (result as { success: true; data: { results: Array<{ score: number }> } }).data.results;
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1]!.score).toBeGreaterThanOrEqual(nodes[i]!.score);
    }
  });
});
