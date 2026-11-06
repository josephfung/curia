import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../../src/memory/embedding.js';
import { EntityMemory } from '../../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../../src/memory/validation.js';
import { createSilentLogger } from '../../../../src/logger.js';
import { MemoryQueryHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';

function makeMemory(): { mem: EntityMemory; store: KnowledgeGraphStore } {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return { mem: new EntityMemory(store, validator, embeddingService, createSilentLogger()), store };
}

function makeEntityMemory(): EntityMemory {
  return makeMemory().mem;
}

type ResultRow = Record<string, unknown> & { id: string; type: string };

async function runQuery(mem: EntityMemory, input: Record<string, unknown>): Promise<ResultRow[]> {
  const result = await new MemoryQueryHandler().execute(makeCtx(mem, input));
  expect(result.success).toBe(true);
  return (result as { success: true; data: { results: ResultRow[] } }).data.results;
}

function makeCtx(entityMemory: EntityMemory, input: Record<string, unknown>): ToolContext {
  return {
    input,
    secret: () => 'test-key',
    log: pino({ level: 'silent' }),
    entityMemory,
  } as unknown as ToolContext;
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
    } as unknown as ToolContext;

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
  // #2502: a fact found by wording alone must say whose fact it is, so it cannot be read
  // as context about the person the query named.
  describe('fact owners', () => {
    it('labels a fact surfaced by a query naming person A with its owner, person B', async () => {
      const mem = makeEntityMemory();
      const { entity: personA } = await mem.createEntity({ type: 'person', label: 'Alice Newcomer', properties: {}, source: 'test' });
      const { entity: personB } = await mem.createEntity({ type: 'person', label: 'Bob Oldfriend', properties: {}, source: 'test' });
      const stored = await mem.storeFact({
        entityNodeId: personB.id,
        label: 'relationship_to_principal: Longtime friend of the principal',
        source: 'test',
      });
      expect(stored.stored).toBe(true);

      const results = await runQuery(mem, { query: 'Alice Newcomer background and relationship to the principal', limit: 50 });

      const fact = results.find((r) => r.type === 'fact');
      expect(fact).toBeDefined();
      expect(fact!.owners).toEqual([{ id: personB.id, type: 'person', label: 'Bob Oldfriend' }]);
      expect(fact!.unattached).toBeUndefined();
      expect(JSON.stringify(fact!.owners)).not.toContain(personA.id);
    });

    it('marks a fact with no live owner as unattached', async () => {
      const { mem, store } = makeMemory();
      const orphan = await store.createNode({ type: 'fact', label: 'orphan fact', properties: {}, source: 'test' });
      const { entity: gone } = await mem.createEntity({ type: 'person', label: 'Archived Owner', properties: {}, source: 'test' });
      const archivedOwnerFact = await store.createNode({ type: 'fact', label: 'fact of an archived owner', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: gone.id, targetNodeId: archivedOwnerFact.id, type: 'relates_to', properties: {}, source: 'test' });
      await store.archiveNode(gone.id);
      // archiveNode archives the owner's edges too; a live edge added afterwards checks that
      // the owner node's own archive flag is honoured, not just the edge's.
      await store.createEdge({ sourceNodeId: gone.id, targetNodeId: archivedOwnerFact.id, type: 'mentioned_in', properties: {}, source: 'test' });

      const results = await runQuery(mem, { query: 'fact', type: 'fact', limit: 50 });

      for (const id of [orphan.id, archivedOwnerFact.id]) {
        const row = results.find((r) => r.id === id);
        expect(row).toMatchObject({ owners: [], unattached: true });
      }
    });

    it('counts an owner above max_sensitivity without naming it', async () => {
      const { mem, store } = makeMemory();
      const { entity: secret } = await mem.createEntity({
        type: 'person', label: 'Restricted Owner', properties: {}, source: 'test', sensitivity: 'restricted',
      });
      const fact = await store.createNode({ type: 'fact', label: 'internal fact', properties: {}, source: 'test', sensitivity: 'internal' });
      await store.createEdge({ sourceNodeId: secret.id, targetNodeId: fact.id, type: 'relates_to', properties: {}, source: 'test' });

      const results = await runQuery(mem, { query: 'internal fact', max_sensitivity: 'internal', limit: 50 });

      const row = results.find((r) => r.id === fact.id)!;
      expect(row).toMatchObject({ owners: [], owners_withheld: 1 });
      expect(row.unattached).toBeUndefined();
      expect(JSON.stringify(results)).not.toContain('Restricted Owner');
      expect(JSON.stringify(results)).not.toContain(secret.id);
    });

    it('classifies a fact at the highest sensitivity among the owners it names', async () => {
      const { mem, store } = makeMemory();
      const { entity: secret } = await mem.createEntity({
        type: 'person', label: 'Restricted Owner', properties: {}, source: 'test', sensitivity: 'restricted',
      });
      const fact = await store.createNode({ type: 'fact', label: 'internal fact', properties: {}, source: 'test', sensitivity: 'internal' });
      await store.createEdge({ sourceNodeId: secret.id, targetNodeId: fact.id, type: 'relates_to', properties: {}, source: 'test' });

      // No max_sensitivity: the owner is named, so the result cannot be reported as internal.
      const results = await runQuery(mem, { query: 'internal fact', limit: 50 });

      const row = results.find((r) => r.id === fact.id)!;
      expect(row.owners).toEqual([{ id: secret.id, type: 'person', label: 'Restricted Owner' }]);
      expect(row.sensitivity).toBe('restricted');
    });

    it('lists at most five owners, entity-to-fact edges first, and counts the rest', async () => {
      const { mem, store } = makeMemory();
      const fact = await store.createNode({ type: 'fact', label: 'shared fact', properties: {}, source: 'test' });
      // The reverse-direction owner sorts last despite its early label.
      const { entity: reverseOwner } = await mem.createEntity({ type: 'organization', label: 'A Reverse Owner', properties: {}, source: 'test' });
      await store.createEdge({ sourceNodeId: fact.id, targetNodeId: reverseOwner.id, type: 'mentioned_in', properties: {}, source: 'test' });
      const forwardIds: string[] = [];
      for (let i = 1; i <= 6; i++) {
        const { entity } = await mem.createEntity({ type: 'person', label: `Owner ${i}`, properties: {}, source: 'test' });
        forwardIds.push(entity.id);
        await store.createEdge({ sourceNodeId: entity.id, targetNodeId: fact.id, type: 'relates_to', properties: {}, source: 'test' });
      }
      // A second edge to the same owner must not count it twice.
      await store.createEdge({ sourceNodeId: forwardIds[0]!, targetNodeId: fact.id, type: 'mentioned_in', properties: {}, source: 'test' });

      const results = await runQuery(mem, { query: 'shared fact', type: 'fact', limit: 50 });

      const row = results.find((r) => r.id === fact.id)!;
      const owners = row.owners as Array<{ id: string; label: string }>;
      expect(owners.map((o) => o.label)).toEqual(['Owner 1', 'Owner 2', 'Owner 3', 'Owner 4', 'Owner 5']);
      expect(row.more_owners).toBe(2);
    });

    it('applies the owner limit to each fact, not to the batch', async () => {
      const { mem, store } = makeMemory();
      const facts = [];
      for (const name of ['alpha', 'beta']) {
        facts.push(await store.createNode({ type: 'fact', label: `batched ${name} fact`, properties: {}, source: 'test' }));
      }
      for (const [fi, fact] of facts.entries()) {
        for (let i = 1; i <= 6; i++) {
          const { entity } = await mem.createEntity({ type: 'person', label: `F${fi} Owner ${i}`, properties: {}, source: 'test' });
          await store.createEdge({ sourceNodeId: entity.id, targetNodeId: fact.id, type: 'relates_to', properties: {}, source: 'test' });
        }
      }

      const results = await runQuery(mem, { query: 'batched fact', type: 'fact', limit: 50 });

      for (const [fi, fact] of facts.entries()) {
        const row = results.find((r) => r.id === fact.id)!;
        const owners = row.owners as Array<{ label: string }>;
        expect(owners.map((o) => o.label)).toEqual([1, 2, 3, 4, 5].map((i) => `F${fi} Owner ${i}`));
        expect(row.more_owners).toBe(1);
        expect(row.unattached).toBeUndefined();
      }
    });

    it('rejects a non-finite owner limit on either backend', async () => {
      const { mem, store } = makeMemory();
      const fact = await store.createNode({ type: 'fact', label: 'some fact', properties: {}, source: 'test' });
      for (const perFactLimit of [NaN, Infinity]) {
        await expect(mem.getFactOwners([fact.id], { perFactLimit })).rejects.toThrow(/finite/);
      }
    });

    it('adds no owner fields to non-fact results', async () => {
      const mem = makeEntityMemory();
      await mem.createEntity({ type: 'person', label: 'Plain Person', properties: {}, source: 'test' });

      const results = await runQuery(mem, { query: 'Plain Person' });

      const person = results.find((r) => r.type === 'person')!;
      expect(person).not.toHaveProperty('owners');
      expect(person).not.toHaveProperty('unattached');
    });

    it('fails the call rather than return facts without owners when the owner lookup throws', async () => {
      const { mem, store } = makeMemory();
      await store.createNode({ type: 'fact', label: 'some fact', properties: {}, source: 'test' });
      vi.spyOn(mem, 'getFactOwners').mockRejectedValueOnce(new Error('db down'));

      const result = await new MemoryQueryHandler().execute(makeCtx(mem, { query: 'some fact' }));

      expect(result).toEqual({ success: false, error: 'db down' });
    });
  });
});
