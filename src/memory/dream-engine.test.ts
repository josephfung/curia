import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { EventBus } from '../bus/bus.js';
import { DreamEngine } from './dream-engine.js';
import { createSilentLogger } from '../logger.js';

// Mock a pool that returns a client whose query() records calls and returns configured rowCounts.
// runDecayPass issues: BEGIN, 4 decay queries, 2 archive queries, COMMIT = 8 total client calls.
// rowCounts applies only to the 6 data queries (indices 1-6); BEGIN and COMMIT return 0 rows.
function makePool(rowCounts: number[] = []): {
  pool: Pool;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let dataCallIndex = 0;

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      // BEGIN and COMMIT always return 0 rowCount
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] } as unknown as QueryResult;
      }
      const rowCount = rowCounts[dataCallIndex++] ?? 0;
      return { rowCount, rows: [] } as unknown as QueryResult;
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    connect: vi.fn(async () => client),
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

    // Should have executed: BEGIN, slow_decay nodes, fast_decay nodes, slow_decay edges,
    // fast_decay edges, archive nodes, archive edges, COMMIT = 8 total
    expect(queries.length).toBe(8);
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
    // No data query should reference 'permanent' as a decay_class parameter
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

  it('wraps the pass in a transaction and releases the client on success', async () => {
    const { pool } = makePool([1, 1, 1, 1, 1, 1]);
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();

    // pool.connect() should have been called once to get the client
    expect(pool.connect).toHaveBeenCalledTimes(1);
    const client = await (pool.connect as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    // client.release() should be called in the finally block
    expect(client.release).toHaveBeenCalledTimes(1);
    // The first query should be BEGIN and last data-less query should be COMMIT
    const allSqls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c as [string])[0],
    );
    expect(allSqls[0]).toBe('BEGIN');
    expect(allSqls[allSqls.length - 1]).toBe('COMMIT');
  });
});
