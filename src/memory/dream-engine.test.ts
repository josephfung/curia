import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import type { EventBus } from '../bus/bus.js';
import { DreamEngine } from './dream-engine.js';
import { createSilentLogger } from '../logger.js';

// Minimal mock pool that records queries
function makePool(rowCounts: number[] = []): { pool: Pool; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let callIndex = 0;
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      const rowCount = rowCounts[callIndex++] ?? 0;
      return { rowCount, rows: [] } as unknown as QueryResult;
    }),
  } as unknown as Pool;
  return { pool, queries };
}

function makeBus(): EventBus {
  return { publish: vi.fn(), subscribe: vi.fn() } as unknown as EventBus;
}

const defaultConfig = {
  intervalMs: 86400000,
  archiveThreshold: 0.05,
  halfLifeDays: {
    permanent: null as null,
    slow_decay: 180,
    fast_decay: 21,
  },
};

describe('DreamEngine.runDecayPass', () => {
  it('runs all three passes and returns counts', async () => {
    const { pool, queries } = makePool([5, 3, 2, 1, 4, 2]);
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    const result = await engine.runDecayPass();

    // Should have executed: slow_decay nodes, fast_decay nodes, slow_decay edges, fast_decay edges, archive nodes, archive edges
    expect(queries.length).toBe(6);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // Row counts from the mock: [5, 3, 2, 1, 4, 2]
    // nodesDecayed = slow_decay nodes (5) + fast_decay nodes (3)
    // edgesDecayed = slow_decay edges (2) + fast_decay edges (1)
    expect(result.nodesDecayed).toBe(8);   // 5 + 3
    expect(result.edgesDecayed).toBe(3);   // 2 + 1
    expect(result.nodesArchived).toBe(4);
    expect(result.edgesArchived).toBe(2);
  });

  it('does not run any SQL for permanent nodes (halfLifeDays.permanent is null)', async () => {
    const { pool, queries } = makePool();
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();
    // No query should reference 'permanent' as a decay_class parameter
    const permanentQueries = queries.filter(q =>
      q.params.some(p => p === 'permanent'),
    );
    expect(permanentQueries).toHaveLength(0);
  });

  it('uses the configured half-life for slow_decay nodes', async () => {
    const { pool, queries } = makePool();
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();
    // Find the slow_decay node decay query — it should include 180 (the half-life)
    const slowDecayNodeQuery = queries.find(q =>
      q.params.includes('slow_decay') && q.sql.includes('kg_nodes'),
    );
    expect(slowDecayNodeQuery).toBeDefined();
    expect(slowDecayNodeQuery!.params).toContain(180);
  });

  it('uses the configured half-life for fast_decay nodes', async () => {
    const { pool, queries } = makePool();
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();
    const fastDecayNodeQuery = queries.find(q =>
      q.params.includes('fast_decay') && q.sql.includes('kg_nodes'),
    );
    expect(fastDecayNodeQuery).toBeDefined();
    expect(fastDecayNodeQuery!.params).toContain(21);
  });

  it('uses the configured archiveThreshold in the archive pass', async () => {
    const { pool, queries } = makePool();
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();
    const archiveNodeQuery = queries.find(q =>
      q.sql.includes('kg_nodes') && q.sql.includes('archived_at = now()'),
    );
    expect(archiveNodeQuery).toBeDefined();
    expect(archiveNodeQuery!.params).toContain(0.05);
  });

  it('archives edges whose endpoints were archived in the same pass', async () => {
    const { pool, queries } = makePool();
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();
    const archiveEdgeQuery = queries.find(q =>
      q.sql.includes('kg_edges') && q.sql.includes('archived_at = now()'),
    );
    expect(archiveEdgeQuery).toBeDefined();
    // The edge archive query must reference archived node endpoints
    expect(archiveEdgeQuery!.sql).toMatch(/source_node_id|target_node_id/);
  });
});
