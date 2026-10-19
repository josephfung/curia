import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createLogger, createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;

// Skip if DATABASE_URL is not set (CI may not have pgvector)
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('Knowledge Graph Integration', () => {
  let pool: pg.Pool;
  let store: KnowledgeGraphStore;
  let entityMemory: EntityMemory;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const logger = createLogger('error');
    const embeddingService = EmbeddingService.createForTesting();
    store = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    // Verify pgvector extension and tables exist
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  // Integration files share one database and run in parallel, so teardown deletes only
  // the nodes this file created (#2183). Edges cascade from their nodes, but are deleted
  // explicitly to keep the FK order visible. This file creates no contacts.
  const createdKgNodeIds: string[] = [];

  afterAll(async () => {
    try {
      if (createdKgNodeIds.length > 0) {
        await pool.query(
          'DELETE FROM kg_edges WHERE source_node_id = ANY($1) OR target_node_id = ANY($1)',
          [createdKgNodeIds],
        );
        await pool.query('DELETE FROM kg_nodes WHERE id = ANY($1)', [createdKgNodeIds]);
      }
    } finally {
      await pool.end();
    }
  });

  it('creates and retrieves a node from Postgres', async () => {
    const node = await store.createNode({
      type: 'person',
      label: 'Integration Test Person',
      properties: { test: true },
      source: 'integration-test',
    });
    createdKgNodeIds.push(node.id);

    const retrieved = await store.getNode(node.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.label).toBe('Integration Test Person');
    expect(retrieved!.embedding).toBeDefined();
    expect(retrieved!.embedding).toHaveLength(1536);
  });

  it('performs semantic search via pgvector', async () => {
    const node = await store.createNode({
      type: 'concept',
      label: 'quarterly revenue targets',
      properties: {},
      source: 'integration-test',
    });
    createdKgNodeIds.push(node.id);

    const results = await store.semanticSearch('financial goals');
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0]!.score).toBe('number');
  });

  it('traverses graph relationships in Postgres', async () => {
    const a = await store.createNode({ type: 'person', label: 'Traverse-A', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'project', label: 'Traverse-B', properties: {}, source: 'test' });
    createdKgNodeIds.push(a.id, b.id);
    await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'works_on', properties: {}, source: 'test' });

    const result = await store.traverse(a.id, { maxDepth: 1 });
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });

  it('stores and retrieves entity facts via EntityMemory', async () => {
    const { entity, created } = await entityMemory.createEntity({
      type: 'person',
      label: 'Integration Person',
      properties: {},
      source: 'test',
    });
    // createEntity upserts by label: only delete the node if this call minted it.
    if (created) createdKgNodeIds.push(entity.id);

    const fact = await entityMemory.storeFact({
      entityNodeId: entity.id,
      label: 'Integration Person is a test entity',
      source: 'test',
    });
    // 'updated' returns an existing fact node, which is not ours to delete.
    if (fact.action === 'created' && fact.nodeId) createdKgNodeIds.push(fact.nodeId);

    const facts = await entityMemory.getFacts(entity.id);
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });
});
