import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { DeleteRelationshipHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeEntityMemory() {
  return makeEntityMemoryWithStore().mem;
}

// Returns both mem and store for tests that need to bypass upsert
// (e.g. to simulate pre-migration duplicate data by inserting directly)
function makeEntityMemoryWithStore() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return { mem: new EntityMemory(store, validator, embeddingService, createSilentLogger()), store };
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
    const ctx = makeCtx(mem, { subject: 'Bob', predicate: 'not_real', object: 'Alice' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/unknown edge type/i);
  });

  it('returns deleted:false (idempotent) when edge does not exist', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' }); // return value not needed
    await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' }); // return value not needed

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Bob', predicate: 'spouse', object: 'Alice' });
    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { deleted: false } });
  });

  it('deletes the edge and returns deleted:true with edge_id', async () => {
    const mem = makeEntityMemory();
    const { entity: bob } = await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const { entity: xiaopu } = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const { edge } = await mem.upsertEdge(bob.id, xiaopu.id, 'spouse', {}, 'test', 0.9);

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Bob', predicate: 'spouse', object: 'Alice' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { deleted: boolean; edge_id: string } }).data;
    expect(data.deleted).toBe(true);
    expect(data.edge_id).toBe(edge.id);

    // Verify the edge is gone
    const remaining = await mem.findEdges(bob.id);
    expect(remaining).toHaveLength(0);
  });

  it('finds the edge regardless of which direction it was stored', async () => {
    const mem = makeEntityMemory();
    const { entity: bob } = await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const { entity: xiaopu } = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    // Stored with xiaopu as source
    await mem.upsertEdge(xiaopu.id, bob.id, 'spouse', {}, 'test', 0.9);

    const handler = new DeleteRelationshipHandler();
    // Deleting with bob as subject — should still find it
    const ctx = makeCtx(mem, { subject: 'Bob', predicate: 'spouse', object: 'Alice' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect((result as { success: true; data: { deleted: boolean } }).data.deleted).toBe(true);
  });

  it('returns ambiguous:true when subject matches multiple nodes', async () => {
    // createEntity uses upsertNode which prevents duplicates.
    // Insert a second node directly to simulate pre-migration duplicate data.
    const { mem, store } = makeEntityMemoryWithStore();
    await mem.createEntity({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });
    await store.createNode({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });
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
    // createEntity uses upsertNode which prevents duplicates.
    // Insert a second node directly to simulate pre-migration duplicate data.
    const { mem, store } = makeEntityMemoryWithStore();
    await mem.createEntity({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'Jane Smith', properties: {}, source: 'test' });
    await store.createNode({ type: 'person', label: 'Jane Smith', properties: {}, source: 'test' });

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Bob', predicate: 'manages', object: 'Jane Smith' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { ambiguous: boolean; ambiguous_field: string } }).data;
    expect(data.ambiguous).toBe(true);
    expect(data.ambiguous_field).toBe('object');
  });

  it('returns deleted:false when subject does not exist', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });

    const handler = new DeleteRelationshipHandler();
    const ctx = makeCtx(mem, { subject: 'Nobody', predicate: 'spouse', object: 'Alice' });
    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { deleted: false } });
  });
});
