import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { DeleteRelationshipHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeEntityMemory() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService);
}

function makeCtx(entityMemory: EntityMemory, input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: () => 'test-key',
    log: pino({ level: 'silent' }),
    entityMemory,
  } as unknown as SkillContext;
}

describe('DeleteRelationshipHandler', () => {
  it('returns error for unknown predicate', async () => {
    const mem = makeEntityMemory();
    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Joseph', predicate: 'not_real', object: 'Xiaopu' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/unknown edge type/i);
  });

  it('returns deleted:false (idempotent) when edge does not exist', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Joseph', predicate: 'spouse', object: 'Xiaopu' });
    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { deleted: false } });
  });

  it('deletes the edge and returns deleted:true with edge_id', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const { edge } = await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Joseph', predicate: 'spouse', object: 'Xiaopu' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { deleted: boolean; edge_id: string } }).data;
    expect(data.deleted).toBe(true);
    expect(data.edge_id).toBe(edge.id);

    // Verify the edge is gone
    const remaining = await mem.findEdges(joseph.id);
    expect(remaining).toHaveLength(0);
  });

  it('finds the edge regardless of which direction it was stored', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    // Stored with xiaopu as source
    await mem.upsertEdge(xiaopu.id, joseph.id, 'spouse', {}, 'test', 0.9);

    const handler = new DeleteRelationshipHandler();
    // Deleting with joseph as subject — should still find it
    const ctx = makeCtx(mem, { subject: 'Joseph', predicate: 'spouse', object: 'Xiaopu' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect((result as { success: true; data: { deleted: boolean } }).data.deleted).toBe(true);
  });

  it('returns ambiguous:true when subject matches multiple nodes', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'Jane', properties: {}, source: 'test' });

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'John Smith', predicate: 'manages', object: 'Jane' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { ambiguous: boolean; ambiguous_field: string; candidates: unknown[] } }).data;
    expect(data.ambiguous).toBe(true);
    expect(data.ambiguous_field).toBe('subject');
    expect(data.candidates).toHaveLength(2);
  });

  it('returns ambiguous:true when object matches multiple nodes', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'Jane Smith', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'Jane Smith', properties: {}, source: 'test' });

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Joseph', predicate: 'manages', object: 'Jane Smith' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { ambiguous: boolean; ambiguous_field: string } }).data;
    expect(data.ambiguous).toBe(true);
    expect(data.ambiguous_field).toBe('object');
  });

  it('returns deleted:false when subject does not exist', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Nobody', predicate: 'spouse', object: 'Xiaopu' });
    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { deleted: false } });
  });
});
