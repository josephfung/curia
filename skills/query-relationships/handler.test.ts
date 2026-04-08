import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { QueryRelationshipsHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeEntityMemory() {
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

describe('QueryRelationshipsHandler', () => {
  it('returns empty relationships when entity is not found', async () => {
    const mem = makeEntityMemory();
    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'Unknown Person' });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { relationships: [], count: 0 } });
  });

  it('returns all relationships for a known entity', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu Fung', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme Corp', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(joseph.id, acme.id, 'member_of', {}, 'test', 0.8);

    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'Joseph Fung' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { relationships: unknown[]; count: number } }).data;
    expect(data.count).toBe(2);
    expect(data.relationships).toHaveLength(2);
  });

  it('filters by edge_type when provided', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu Fung', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme Corp', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(joseph.id, acme.id, 'member_of', {}, 'test', 0.8);

    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'Joseph Fung', edge_type: 'spouse' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { relationships: Array<{ predicate: string }>; count: number } }).data;
    expect(data.count).toBe(1);
    expect(data.relationships[0]!.predicate).toBe('spouse');
  });

  it('returns ambiguous:true with candidates when multiple nodes match', async () => {
    const mem = makeEntityMemory();
    // Two nodes with the same label
    await mem.createEntity({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });

    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'John Smith' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { ambiguous: boolean; candidates: unknown[] } }).data;
    expect(data.ambiguous).toBe(true);
    expect(data.candidates).toHaveLength(2);
  });

  it('returns error for an unknown edge_type', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });

    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'Joseph Fung', edge_type: 'not_a_real_type' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/unknown edge type/i);
  });

  it('labels outbound and inbound direction correctly', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu Fung', properties: {}, source: 'test' });
    // Edge is stored outbound from joseph to xiaopu
    await mem.upsertEdge(joseph.id, xiaopu.id, 'manages', {}, 'test', 0.8);

    const handler = new QueryRelationshipsHandler();

    // Query from joseph's perspective
    const josephCtx = makeCtx(mem, { entity: 'Joseph Fung' });
    const josephResult = await handler.execute(josephCtx);
    const josephData = (josephResult as { success: true; data: { relationships: Array<{ direction: string; subject: string; object: string }> } }).data;
    expect(josephData.relationships[0]!.direction).toBe('outbound');
    expect(josephData.relationships[0]!.subject).toBe('Joseph Fung');
    expect(josephData.relationships[0]!.object).toBe('Xiaopu Fung');

    // Query from xiaopu's perspective — same edge, inbound
    const xiaopuCtx = makeCtx(mem, { entity: 'Xiaopu Fung' });
    const xiaopuResult = await handler.execute(xiaopuCtx);
    const xiaopuData = (xiaopuResult as { success: true; data: { relationships: Array<{ direction: string; subject: string; object: string }> } }).data;
    expect(xiaopuData.relationships[0]!.direction).toBe('inbound');
    expect(xiaopuData.relationships[0]!.subject).toBe('Joseph Fung');
    expect(xiaopuData.relationships[0]!.object).toBe('Xiaopu Fung');
  });
});
