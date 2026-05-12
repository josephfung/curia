import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { EventBus } from '../bus/bus.js';
import { DreamEngine } from './dream-engine.js';
import { createSilentLogger } from '../logger.js';
import type { AutonomyScoringPass } from '../autonomy/scoring-pass.js';

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
  edgeCountPercentile: 0.95,
  edgeCountFloor: 5,
  warnHoldBackDays: 7,
};

// Default 9-response set for tests that only care about specific queries and don't
// need custom row counts. Provides a valid threshold row and zero-count results.
const defaultResponses = () => [
  { rowCount: 0 },                        // 1a slow nodes
  { rowCount: 0 },                        // 1b fast nodes
  { rowCount: 0 },                        // 1c slow edges
  { rowCount: 0 },                        // 1d fast edges
  { rows: [{ threshold: 10 }] },         // percentile threshold
  { rowCount: 0, rows: [] },             // warn pass
  { rowCount: 0 },                        // expire warnings
  { rowCount: 0 },                        // archive nodes
  { rowCount: 0 },                        // archive edges
];

describe('DreamEngine.runDecayPass', () => {
  it('runs all three passes and returns counts', async () => {
    // Query order: BEGIN, slow nodes, fast nodes, slow edges, fast edges,
    //   percentile threshold, warn pass, expire warnings, archive nodes, archive edges, COMMIT
    const { pool, queries } = makePoolWithResponses([
      { rowCount: 5 },                         // 1a slow nodes
      { rowCount: 3 },                         // 1b fast nodes
      { rowCount: 2 },                         // 1c slow edges
      { rowCount: 1 },                         // 1d fast edges
      { rows: [{ threshold: 10 }] },          // percentile threshold
      { rowCount: 1, rows: [                   // warn pass
        { id: 'n1', type: 'fact', label: 'L', confidence: 0.04,
          sensitivity: 'confidential', edge_count: '2', warn_reason: 'high_sensitivity', warned_at: new Date() },
      ] },
      { rowCount: 0 },                         // expire warnings
      { rowCount: 4 },                         // archive nodes
      { rowCount: 2 },                         // archive edges
    ]);
    const bus = makeBus();
    const engine = new DreamEngine(pool, bus, createSilentLogger(), warnConfig);
    const result = await engine.runDecayPass();

    expect(queries.length).toBe(11);  // BEGIN + 9 data queries + COMMIT
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.nodesDecayed).toBe(8);   // 5 + 3
    expect(result.edgesDecayed).toBe(3);   // 2 + 1
    expect(result.nodesWarned).toBe(1);
    expect(result.nodesExpired).toBe(0);
    expect(result.nodesArchived).toBe(4);
    expect(result.edgesArchived).toBe(2);
  });

  it('does not run any SQL for permanent nodes (halfLifeDays.permanent is null)', async () => {
    const { pool, queries } = makePoolWithResponses(defaultResponses());
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();
    // No data query should reference 'permanent' as a decay_class parameter
    const permanentQueries = queries.filter(q =>
      q.params.some(p => p === 'permanent'),
    );
    expect(permanentQueries).toHaveLength(0);
  });

  it('uses the configured half-life for slow_decay nodes', async () => {
    const { pool, queries } = makePoolWithResponses(defaultResponses());
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
    const { pool, queries } = makePoolWithResponses(defaultResponses());
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();
    const fastDecayNodeQuery = queries.find(q =>
      q.params.includes('fast_decay') && q.sql.includes('kg_nodes'),
    );
    expect(fastDecayNodeQuery).toBeDefined();
    expect(fastDecayNodeQuery!.params).toContain(21);
  });

  it('uses the configured archiveThreshold in the archive pass', async () => {
    const { pool, queries } = makePoolWithResponses(defaultResponses());
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    await engine.runDecayPass();
    // Pass 2b archives regular nodes — it uses archiveThreshold as its sole param.
    // Find it by looking for a kg_nodes archive query whose params include the threshold value.
    const archiveNodeQuery = queries.find(q =>
      q.sql.trimStart().startsWith('UPDATE kg_nodes') &&
      q.sql.includes('archived_at = now()') &&
      q.params.includes(0.05),
    );
    expect(archiveNodeQuery).toBeDefined();
    expect(archiveNodeQuery!.params).toContain(0.05);
  });

  it('archives edges whose endpoints were archived in the same pass', async () => {
    const { pool, queries } = makePoolWithResponses(defaultResponses());
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
    const { pool } = makePoolWithResponses(defaultResponses());
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

// Richer mock: each response maps to a query call in order.
// { rowCount, rows } — rows defaults to [], rowCount defaults to 0.
function makePoolWithResponses(responses: Array<{ rowCount?: number; rows?: unknown[] }>): {
  pool: Pool;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let callIndex = 0;

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] } as unknown as QueryResult;
      }
      const resp = responses[callIndex++] ?? { rowCount: 0, rows: [] };
      return { rowCount: resp.rowCount ?? 0, rows: resp.rows ?? [] } as unknown as QueryResult;
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;

  return { pool, queries };
}

const warnConfig = {
  ...defaultConfig,
  edgeCountPercentile: 0.90,  // different from defaultConfig (0.95)
  edgeCountFloor: 3,           // different from defaultConfig (5)
  warnHoldBackDays: 14,        // different from defaultConfig (7)
};

describe('DreamEngine warn pass', () => {
  it('emits memory.decay_warning for each newly warned node', async () => {
    const warnedRows = [
      { id: 'node-1', type: 'person', label: 'Alice', confidence: 0.04,
        sensitivity: 'confidential', edge_count: '3', warn_reason: 'high_sensitivity', warned_at: new Date() },
      { id: 'node-2', type: 'fact', label: 'Budget 2025', confidence: 0.04,
        sensitivity: 'internal', edge_count: '12', warn_reason: 'high_connectivity', warned_at: new Date() },
    ];
    const { pool } = makePoolWithResponses([
      { rowCount: 5 },                             // 1a: slow nodes
      { rowCount: 3 },                             // 1b: fast nodes
      { rowCount: 2 },                             // 1c: slow edges
      { rowCount: 1 },                             // 1d: fast edges
      { rows: [{ threshold: 10 }] },              // percentile threshold
      { rowCount: 2, rows: warnedRows },           // warn pass RETURNING
      { rowCount: 0 },                             // expire stale warnings
      { rowCount: 0 },                             // archive regular nodes
      { rowCount: 0 },                             // archive edges
    ]);
    const bus = makeBus();
    const engine = new DreamEngine(pool, bus, createSilentLogger(), warnConfig);
    const result = await engine.runDecayPass();

    expect(result.nodesWarned).toBe(2);
    expect(bus.publish).toHaveBeenCalledTimes(2);
    const firstCall = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(firstCall[0]).toBe('system');
    expect(firstCall[1].type).toBe('memory.decay_warning');
    expect(firstCall[1].payload.nodeId).toBe('node-1');
    expect(firstCall[1].payload.reason).toBe('high_sensitivity');
    const secondCall = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(secondCall[1].payload.nodeId).toBe('node-2');
    expect(secondCall[1].payload.reason).toBe('high_connectivity');
  });

  it('does not emit events when no nodes are warned', async () => {
    const { pool } = makePoolWithResponses([
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
      { rows: [{ threshold: 10 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
    ]);
    const bus = makeBus();
    const engine = new DreamEngine(pool, bus, createSilentLogger(), warnConfig);
    const result = await engine.runDecayPass();

    expect(result.nodesWarned).toBe(0);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('passes edgeCountPercentile and edgeCountFloor to the threshold query', async () => {
    const { pool, queries } = makePoolWithResponses([
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
      { rows: [{ threshold: 10 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
    ]);
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), warnConfig);
    await engine.runDecayPass();

    const thresholdQuery = queries.find(q => q.sql.includes('percentile_disc'));
    expect(thresholdQuery).toBeDefined();
    expect(thresholdQuery!.params).toContain(0.90);
    expect(thresholdQuery!.params).toContain(3);
  });

  it('sets warned_at and warn_reason in the warn UPDATE query', async () => {
    const { pool, queries } = makePoolWithResponses([
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
      { rows: [{ threshold: 10 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
    ]);
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), warnConfig);
    await engine.runDecayPass();

    const warnQuery = queries.find(q =>
      q.sql.includes('warned_at') && q.sql.includes('warn_reason') && q.sql.includes('RETURNING'),
    );
    expect(warnQuery).toBeDefined();
    expect(warnQuery!.sql).toMatch(/HAVING/);
  });

  it('returns nodesExpired count from expired-warning archive pass', async () => {
    const { pool } = makePoolWithResponses([
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
      { rows: [{ threshold: 10 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 3 },   // expire stale warnings
      { rowCount: 1 },   // archive regular nodes
      { rowCount: 2 },   // archive edges
    ]);
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), warnConfig);
    const result = await engine.runDecayPass();

    expect(result.nodesExpired).toBe(3);
    expect(result.nodesArchived).toBe(1);
  });

  it('excludes warned nodes (within hold-back window) from the regular archive pass', async () => {
    const { pool, queries } = makePoolWithResponses([
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
      { rows: [{ threshold: 10 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
    ]);
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), warnConfig);
    await engine.runDecayPass();

    // Filter to queries that UPDATE kg_nodes and set archived_at (excludes the edge
    // archive query, which updates kg_edges even though it subqueries kg_nodes).
    const regularArchiveQuery = queries.filter(q =>
      q.sql.trimStart().startsWith('UPDATE kg_nodes') && q.sql.includes('archived_at = now()'),
    );
    expect(regularArchiveQuery.length).toBeGreaterThanOrEqual(2);
    const pass2b = regularArchiveQuery[regularArchiveQuery.length - 1]!;
    expect(pass2b.sql).toMatch(/warned_at IS NULL/);
  });
});

describe('DreamEngine with AutonomyScoringPass', () => {
  it('calls scoringPass.run() on its own interval', async () => {
    vi.useFakeTimers();
    const { pool } = makePool();
    const mockScoringPass = {
      intervalMs: 86_400_000,  // daily — matches what DreamEngine reads to schedule the interval
      run: vi.fn().mockResolvedValue({ rowsScored: 0, adjustmentApplied: false }),
    };
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig, mockScoringPass as unknown as AutonomyScoringPass);
    engine.start();

    // Advance past the scoring interval (daily = 86400000ms)
    await vi.advanceTimersByTimeAsync(86_400_000);

    expect(mockScoringPass.run).toHaveBeenCalledTimes(1);

    engine.stop();
    vi.useRealTimers();
  });

  it('does not fail if scoringPass is not provided', () => {
    const { pool } = makePool();
    // No scoring pass — should not throw
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    engine.start();
    engine.stop();
  });

  it('logs error and continues if scoringPass.run() throws', async () => {
    vi.useFakeTimers();
    const { pool } = makePool();
    const mockScoringPass = {
      intervalMs: 86_400_000,  // daily — must be present so DreamEngine.start() gets a valid delay
      run: vi.fn().mockRejectedValue(new Error('judge exploded')),
    };
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig, mockScoringPass as unknown as AutonomyScoringPass);
    engine.start();

    // Should not throw — the error is caught and logged
    await vi.advanceTimersByTimeAsync(86_400_000);

    expect(mockScoringPass.run).toHaveBeenCalledTimes(1);

    engine.stop();
    vi.useRealTimers();
  });
});
