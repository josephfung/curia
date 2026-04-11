import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { DreamEngine } from '../../src/memory/dream-engine.js';
import { createSilentLogger } from '../../src/logger.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

// Minimal EventBus stub — bus is injected now but unused until decay warning pass (#280).
function makeBus(): EventBus {
  return { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;
}

const testConfig = {
  intervalMs: 86400000,
  archiveThreshold: 0.05,
  halfLifeDays: { permanent: null as null, slow_decay: 180, fast_decay: 21 },
};

describeIf('DreamEngine integration', () => {
  let pool: pg.Pool;
  let store: KnowledgeGraphStore;
  let engine: DreamEngine;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const embeddingService = EmbeddingService.createForTesting();
    store = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, createSilentLogger());
    engine = new DreamEngine(pool, makeBus(), createSilentLogger(), testConfig);
    // Verify tables are accessible (migration has been run)
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterAll(async () => {
    // Clean up all test data in FK-safe order.
    // Contacts tables may reference kg_nodes, so clear them first.
    await pool.query('DELETE FROM contact_auth_overrides');
    await pool.query('DELETE FROM contact_channel_identities');
    await pool.query('DELETE FROM contacts');
    await pool.query('DELETE FROM kg_edges');
    await pool.query('DELETE FROM kg_nodes');
    await pool.end();
  });

  it('decays confidence on a fast_decay node based on age', async () => {
    // Insert a node whose last_confirmed_at is 21 days ago (one full half-life).
    // After one half-life the formula gives confidence × 0.5^1 = 0.8 × 0.5 = 0.4.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity)
       VALUES ('fact', 'decay-test-fast', '{}', 0.8, 'fast_decay', 'test',
               now() - interval '21 days', now() - interval '21 days', 'internal')
       RETURNING id`,
    );
    const nodeId = rows[0]!.id;

    await engine.runDecayPass();

    const result = await pool.query<{ confidence: number }>(
      'SELECT confidence FROM kg_nodes WHERE id = $1',
      [nodeId],
    );
    // After one half-life (21 days), confidence should be ~0.4 (half of 0.8).
    // Allow ±0.05 tolerance for floating point.
    expect(result.rows[0]!.confidence).toBeCloseTo(0.4, 1);
  });

  it('archives a node whose confidence falls at or below archiveThreshold', async () => {
    // Insert a node already at the threshold — runDecayPass Pass 2 should archive it.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity)
       VALUES ('fact', 'decay-test-archive', '{}', 0.05, 'fast_decay', 'test',
               now() - interval '1 day', now() - interval '1 day', 'internal')
       RETURNING id`,
    );
    const nodeId = rows[0]!.id;

    await engine.runDecayPass();

    const result = await pool.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM kg_nodes WHERE id = $1',
      [nodeId],
    );
    expect(result.rows[0]!.archived_at).not.toBeNull();
  });

  it('archived node does not appear in semanticSearch', async () => {
    const node = await store.createNode({
      type: 'fact', label: 'archived-search-test', properties: {}, source: 'test',
    });
    await store.archiveNode(node.id);

    const results = await store.semanticSearch('archived-search-test');
    expect(results.map(r => r.node.id)).not.toContain(node.id);
  });

  it('archived node does not appear in findNodesByType', async () => {
    const node = await store.createNode({
      type: 'concept', label: 'archived-type-test', properties: {}, source: 'test',
    });
    await store.archiveNode(node.id);

    const results = await store.findNodesByType('concept');
    expect(results.map(n => n.id)).not.toContain(node.id);
  });

  it('archived node does not appear in findNodesByLabel', async () => {
    const node = await store.createNode({
      type: 'fact', label: 'archived-label-test', properties: {}, source: 'test',
    });
    await store.archiveNode(node.id);

    const results = await store.findNodesByLabel('archived-label-test');
    expect(results).toHaveLength(0);
  });

  it('archived node does not appear in traverse', async () => {
    const a = await store.createNode({ type: 'person', label: 'traversal-source', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'project', label: 'traversal-archived-target', properties: {}, source: 'test' });
    await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'works_on', properties: {}, source: 'test' });
    await store.archiveNode(b.id);

    const result = await store.traverse(a.id, { maxDepth: 2 });
    expect(result.nodes.map(n => n.id)).not.toContain(b.id);
  });

  it('archives edges when their source node is archived in the decay pass', async () => {
    const a = await store.createNode({ type: 'person', label: 'edge-cascade-source', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'project', label: 'edge-cascade-target', properties: {}, source: 'test' });
    const edge = await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'works_on', properties: {}, source: 'test' });

    // Archive node a directly to simulate a prior decay pass having condemned it.
    // Pass 3 of runDecayPass should then cascade the archive to any edges touching a.
    await pool.query('UPDATE kg_nodes SET archived_at = now() WHERE id = $1', [a.id]);

    await engine.runDecayPass();

    const { rows } = await pool.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM kg_edges WHERE id = $1',
      [edge.id],
    );
    expect(rows[0]!.archived_at).not.toBeNull();
  });

  it('does not archive permanent nodes regardless of age', async () => {
    // A node 1000 days old with permanent decay should never be touched.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity)
       VALUES ('fact', 'permanent-test', '{}', 0.9, 'permanent', 'test',
               now() - interval '1000 days', now() - interval '1000 days', 'internal')
       RETURNING id`,
    );
    const nodeId = rows[0]!.id;

    await engine.runDecayPass();

    const result = await pool.query<{ confidence: number; archived_at: Date | null }>(
      'SELECT confidence, archived_at FROM kg_nodes WHERE id = $1',
      [nodeId],
    );
    expect(result.rows[0]!.archived_at).toBeNull();
    expect(result.rows[0]!.confidence).toBe(0.9); // unchanged
  });
});
