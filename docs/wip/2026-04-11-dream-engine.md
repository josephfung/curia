# Dream Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the DreamEngine — a background system that runs exponential confidence decay on knowledge graph nodes and edges, soft-deleting (archiving) items whose confidence falls below a threshold.

**Architecture:** A dedicated `DreamEngine` class in `src/memory/` runs three SQL passes on a configurable interval: decay confidence on `slow_decay`/`fast_decay` nodes and edges, archive nodes at or below the threshold, archive edges whose endpoints were archived or whose own confidence crossed the threshold. All KG read paths are updated to filter out archived rows via `WHERE archived_at IS NULL`. The engine is wired into `Scheduler.start()` alongside the existing poll and watchdog intervals.

**Tech Stack:** TypeScript/ESM, Node 22+, PostgreSQL 16+ with node-postgres (`pg`), Vitest for tests.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/db/migrations/024_add_kg_archived_at.sql` | Create | Adds `archived_at` column + indexes to both KG tables |
| `src/memory/dream-engine.ts` | Create | `DreamEngine` class — decay + archive passes |
| `src/memory/dream-engine.test.ts` | Create | Unit tests for decay math and pass logic |
| `tests/integration/dream-engine.test.ts` | Create | Integration tests against real Postgres |
| `src/memory/knowledge-graph.ts` | Modify | Add `WHERE archived_at IS NULL` to all read paths; add `archived_at` to `PgNodeRow`/`PgEdgeRow` |
| `src/config.ts` | Modify | Add `dreaming` block to `YamlConfig` interface + validation |
| `config/default.yaml` | Modify | Add `dreaming.decay` config block with defaults |
| `src/scheduler/scheduler.ts` | Modify | Wire `DreamEngine` into `start()` and `stop()` |
| `src/index.ts` | Modify | Construct `DreamEngine` and pass to `Scheduler` |
| `CHANGELOG.md` | Modify | Add entry under `[Unreleased]` |

---

## Task 1: Database migration

**Files:**
- Create: `src/db/migrations/024_add_kg_archived_at.sql`

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/024_add_kg_archived_at.sql`:

```sql
-- Up Migration

-- Add soft-delete column to knowledge graph nodes and edges (dream engine, issue #27).
-- archived_at is NULL for active rows; set to the archiving timestamp for soft-deleted rows.
-- Partial indexes on the NULL case keep read-path performance equivalent to the pre-migration
-- full-table scan — the planner uses these indexes for all WHERE archived_at IS NULL queries.

ALTER TABLE kg_nodes ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE kg_edges ADD COLUMN archived_at TIMESTAMPTZ;

-- Partial index covering active nodes only (the overwhelming majority of rows).
CREATE INDEX idx_kg_nodes_archived_at ON kg_nodes (archived_at) WHERE archived_at IS NULL;
-- Partial index covering active edges only.
CREATE INDEX idx_kg_edges_archived_at ON kg_edges (archived_at) WHERE archived_at IS NULL;
```

- [ ] **Step 2: Run the migration against your local DB**

```bash
npm --prefix /path/to/worktree run db:migrate
```

Expected: migration runs without error, `\d kg_nodes` in psql shows `archived_at timestamptz` column.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/db/migrations/024_add_kg_archived_at.sql
git -C /path/to/worktree commit -m "chore: add archived_at column to kg_nodes and kg_edges (issue #27)"
```

---

## Task 2: Update KG read paths to filter archived rows

**Files:**
- Modify: `src/memory/knowledge-graph.ts`

All query methods inside `PostgresBackend` need `WHERE archived_at IS NULL`. The in-memory backend needs matching filter logic. `PgNodeRow` and `PgEdgeRow` interfaces need the new column.

- [ ] **Step 1: Write failing unit tests**

Add a new file `src/memory/dream-engine-kg-filter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';

function makeStore() {
  return KnowledgeGraphStore.createInMemory(EmbeddingService.createForTesting());
}

describe('KnowledgeGraphStore: archived row filtering', () => {
  it('getNode returns undefined for an archived node', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'fact', label: 'stale fact', properties: {}, source: 'test' });
    await store.archiveNode(node.id);
    const result = await store.getNode(node.id);
    expect(result).toBeUndefined();
  });

  it('findNodesByType excludes archived nodes', async () => {
    const store = makeStore();
    const active = await store.createNode({ type: 'fact', label: 'active fact', properties: {}, source: 'test' });
    const archived = await store.createNode({ type: 'fact', label: 'archived fact', properties: {}, source: 'test' });
    await store.archiveNode(archived.id);
    const results = await store.findNodesByType('fact');
    expect(results.map(n => n.id)).toContain(active.id);
    expect(results.map(n => n.id)).not.toContain(archived.id);
  });

  it('findNodesByLabel excludes archived nodes', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'fact', label: 'decayed coffee pref', properties: {}, source: 'test' });
    await store.archiveNode(node.id);
    const results = await store.findNodesByLabel('decayed coffee pref');
    expect(results).toHaveLength(0);
  });

  it('getEdgesForNode excludes archived edges', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
    const edge = await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'collaborates_with', properties: {}, source: 'test' });
    await store.archiveEdge(edge.id);
    const edges = await store.getEdgesForNode(a.id);
    expect(edges).toHaveLength(0);
  });

  it('traverse excludes archived nodes and edges', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Traverse-A', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'project', label: 'Traverse-B', properties: {}, source: 'test' });
    await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'works_on', properties: {}, source: 'test' });
    await store.archiveNode(b.id);
    const result = await store.traverse(a.id, { maxDepth: 2 });
    expect(result.nodes.map(n => n.id)).not.toContain(b.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix /path/to/worktree test src/memory/dream-engine-kg-filter.test.ts
```

Expected: FAIL — `store.archiveNode` and `store.archiveEdge` do not exist yet.

- [ ] **Step 3: Add `archiveNode` and `archiveEdge` to the `KnowledgeGraphBackend` interface**

In `src/memory/knowledge-graph.ts`, add two methods to the `KnowledgeGraphBackend` interface (around line 58):

```typescript
/** Soft-delete a node by setting archived_at = now(). Used by DreamEngine. */
archiveNode(id: string): Promise<void>;
/** Soft-delete an edge by setting archived_at = now(). Used by DreamEngine. */
archiveEdge(id: string): Promise<void>;
```

- [ ] **Step 4: Add `archiveNode` and `archiveEdge` to the public `KnowledgeGraphStore` class**

After the existing `deleteNode` method (around line 215):

```typescript
/** Soft-delete a node — sets archived_at, does not remove the row. */
async archiveNode(id: string): Promise<void> {
  return this.backend.archiveNode(id);
}

/** Soft-delete an edge — sets archived_at, does not remove the row. */
async archiveEdge(id: string): Promise<void> {
  return this.backend.archiveEdge(id);
}
```

- [ ] **Step 5: Add `archived_at` to `PgNodeRow` and `PgEdgeRow`**

In the `PgNodeRow` interface (around line 585):

```typescript
archived_at: Date | null;
```

In the `PgEdgeRow` interface (around line 599):

```typescript
archived_at: Date | null;
```

(The `pgRowToNode` and `pgRowToEdge` converters don't need to expose `archived_at` on `KgNode`/`KgEdge` — it's an internal storage concern. The `KgNode` and `KgEdge` types in `types.ts` don't need updating.)

- [ ] **Step 6: Implement `archiveNode` and `archiveEdge` in `PostgresBackend`**

Add after `deleteNode` in `PostgresBackend`:

```typescript
async archiveNode(id: string): Promise<void> {
  this.logger.debug({ nodeId: id }, 'kg: archiving node');
  await this.pool.query('UPDATE kg_nodes SET archived_at = now() WHERE id = $1', [id]);
}

async archiveEdge(id: string): Promise<void> {
  this.logger.debug({ edgeId: id }, 'kg: archiving edge');
  await this.pool.query('UPDATE kg_edges SET archived_at = now() WHERE id = $1', [id]);
}
```

- [ ] **Step 7: Implement `archiveNode` and `archiveEdge` in the in-memory backend**

The in-memory backend stores nodes in a `Map`. Add an `archivedNodes` Set and `archivedEdges` Set, then implement the methods and update all read paths in the in-memory backend to filter on those sets.

Find the in-memory backend class (it's a private class inside `knowledge-graph.ts`). Add:

```typescript
private archivedNodes = new Set<string>();
private archivedEdges = new Set<string>();

async archiveNode(id: string): Promise<void> {
  this.archivedNodes.add(id);
}

async archiveEdge(id: string): Promise<void> {
  this.archivedEdges.add(id);
}
```

Then update each read method in the in-memory backend to filter:

`getNode`: return `undefined` if `this.archivedNodes.has(id)`.

`findNodesByType`: filter out archived nodes.

`findNodesByLabel`: filter out archived nodes.

`getEdgesForNode`: filter out archived edges.

`traverse`: filter archived nodes and edges from traversal results.

`semanticSearch`: filter out archived nodes.

`upsertNode`: check that the existing node (if found by label) is not archived before returning it as a match — an archived node should be treated as non-existent for the purposes of upsert.

- [ ] **Step 8: Update `PostgresBackend` read queries to add `WHERE archived_at IS NULL`**

Update each method:

`getNode` (line ~385):
```typescript
'SELECT * FROM kg_nodes WHERE id = $1 AND archived_at IS NULL'
```

`findNodesByType` (line ~418):
```typescript
'SELECT * FROM kg_nodes WHERE type = $1 AND archived_at IS NULL'
```

`findNodesByLabel` (line ~426):
```typescript
'SELECT * FROM kg_nodes WHERE lower(label) = lower($1) AND archived_at IS NULL'
```

`getEdgesForNode` (line ~455):
```typescript
'SELECT * FROM kg_edges WHERE (source_node_id = $1 OR target_node_id = $1) AND archived_at IS NULL'
```

`traverse` — update the recursive CTE to filter both nodes and edges (lines ~526–561):
```typescript
`WITH RECURSIVE reachable AS (
  SELECT $1::uuid AS node_id, 0 AS depth, ARRAY[$1::uuid] AS visited
  UNION ALL
  SELECT
    CASE WHEN e.source_node_id = r.node_id THEN e.target_node_id ELSE e.source_node_id END,
    r.depth + 1,
    r.visited || CASE WHEN e.source_node_id = r.node_id THEN e.target_node_id ELSE e.source_node_id END
  FROM reachable r
  JOIN kg_edges e ON (e.source_node_id = r.node_id OR e.target_node_id = r.node_id)
  WHERE r.depth < $2
    AND e.archived_at IS NULL
    AND NOT (CASE WHEN e.source_node_id = r.node_id THEN e.target_node_id ELSE e.source_node_id END) = ANY(r.visited)
)
SELECT DISTINCT n.* FROM reachable r JOIN kg_nodes n ON n.id = r.node_id WHERE n.archived_at IS NULL`
```

Edge collection step in `traverse`:
```typescript
`SELECT e.* FROM kg_edges e
 WHERE e.source_node_id = ANY($1::uuid[])
   AND e.target_node_id = ANY($1::uuid[])
   AND e.archived_at IS NULL`
```

`semanticSearch` (line ~564):
```typescript
`SELECT *, 1 - (embedding <=> $1::vector) AS similarity
 FROM kg_nodes
 WHERE embedding IS NOT NULL
   AND archived_at IS NULL
 ORDER BY embedding <=> $1::vector
 LIMIT $2`
```

`upsertNode` — the `ON CONFLICT` clause matches on `lower(label), type WHERE type != 'fact'`. When there's a conflict, add a check: if the existing node is archived, treat it as a miss and insert a new row. Add `AND archived_at IS NULL` to the conflict-resolution `DO UPDATE` condition:

The existing upsert SQL uses `ON CONFLICT (lower(label), type) WHERE type != 'fact'`. Change the DO UPDATE to only fire for non-archived rows by adding a guard in the WHERE clause. The simplest approach: after upsert, check if the returned row has `archived_at IS NOT NULL` — if so, do a fresh INSERT (the archived row is treated as non-existent). This avoids rewriting the complex upsert SQL.

Actually, the cleaner approach: add `AND archived_at IS NULL` to the partial unique index in the migration. This way conflicts only trigger for active nodes, and a new node with the same label as an archived one inserts fresh. Update the migration:

```sql
-- In 024_add_kg_archived_at.sql, after the ALTER TABLE statements, add:
-- Drop the existing uniqueness index and recreate it scoped to active nodes only.
-- This ensures a new node with the same label as an archived node inserts as a new row
-- rather than triggering the ON CONFLICT path.
DROP INDEX IF EXISTS idx_kg_nodes_label_type_unique;
CREATE UNIQUE INDEX idx_kg_nodes_label_type_unique
  ON kg_nodes (lower(label), type)
  WHERE type != 'fact' AND archived_at IS NULL;
```

Check the actual index name first — look in `src/db/migrations/016_kg_node_uniqueness.sql` before writing the DROP.

- [ ] **Step 9: Run tests to verify they pass**

```bash
npm --prefix /path/to/worktree test src/memory/dream-engine-kg-filter.test.ts
```

Expected: all PASS.

- [ ] **Step 10: Run the full test suite to check for regressions**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git -C /path/to/worktree add src/memory/knowledge-graph.ts src/memory/dream-engine-kg-filter.test.ts
git -C /path/to/worktree commit -m "feat: filter archived nodes/edges from all KG read paths (issue #27)"
```

---

## Task 3: Config — add `dreaming` block to `YamlConfig`

**Files:**
- Modify: `src/config.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Write failing config validation tests**

Add a new file `src/config.dreaming.test.ts` (alongside other config tests if any, otherwise place in `src/`):

```typescript
import { describe, it, expect } from 'vitest';
import { loadYamlConfig } from './config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function writeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-'));
  fs.writeFileSync(path.join(dir, 'default.yaml'), content);
  return dir;
}

describe('loadYamlConfig: dreaming block', () => {
  it('accepts valid dreaming.decay config', () => {
    const dir = writeTempConfig(`
dreaming:
  decay:
    intervalMs: 86400000
    archiveThreshold: 0.05
    halfLifeDays:
      permanent: null
      slow_decay: 180
      fast_decay: 21
`);
    const config = loadYamlConfig(dir);
    expect(config.dreaming?.decay?.intervalMs).toBe(86400000);
    expect(config.dreaming?.decay?.archiveThreshold).toBe(0.05);
    expect(config.dreaming?.decay?.halfLifeDays?.slow_decay).toBe(180);
    expect(config.dreaming?.decay?.halfLifeDays?.permanent).toBeNull();
  });

  it('rejects intervalMs that is not a positive integer', () => {
    const dir = writeTempConfig(`
dreaming:
  decay:
    intervalMs: -1
`);
    expect(() => loadYamlConfig(dir)).toThrow('dreaming.decay.intervalMs');
  });

  it('rejects archiveThreshold outside 0-1', () => {
    const dir = writeTempConfig(`
dreaming:
  decay:
    archiveThreshold: 1.5
`);
    expect(() => loadYamlConfig(dir)).toThrow('dreaming.decay.archiveThreshold');
  });

  it('rejects non-positive halfLifeDays', () => {
    const dir = writeTempConfig(`
dreaming:
  decay:
    halfLifeDays:
      slow_decay: 0
`);
    expect(() => loadYamlConfig(dir)).toThrow('dreaming.decay.halfLifeDays.slow_decay');
  });

  it('accepts absent dreaming block (uses defaults)', () => {
    const dir = writeTempConfig('agents: {}');
    const config = loadYamlConfig(dir);
    expect(config.dreaming).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix /path/to/worktree test src/config.dreaming.test.ts
```

Expected: FAIL — `dreaming` property does not exist on `YamlConfig`.

- [ ] **Step 3: Add `dreaming` to `YamlConfig` interface in `src/config.ts`**

Add after the `intentDrift` block (around line 193):

```typescript
dreaming?: {
  decay?: {
    /** How often the decay pass runs in milliseconds. Default: 86400000 (daily). */
    intervalMs?: number;
    /** Confidence at or below this value triggers soft-delete. Default: 0.05. */
    archiveThreshold?: number;
    /** Half-life in days per decay class. null = never decays. */
    halfLifeDays?: {
      permanent?: null;
      slow_decay?: number;
      fast_decay?: number;
    };
  };
};
```

- [ ] **Step 4: Add validation for the `dreaming` block in `loadYamlConfig`**

Add after the `intentDrift` validation block (around line 354):

```typescript
const dreaming = config.dreaming;
if (dreaming !== undefined) {
  if (typeof dreaming !== 'object' || dreaming === null || Array.isArray(dreaming)) {
    throw new Error('dreaming must be a YAML mapping');
  }
  const decay = dreaming.decay;
  if (decay !== undefined) {
    if (typeof decay !== 'object' || decay === null || Array.isArray(decay)) {
      throw new Error('dreaming.decay must be a YAML mapping');
    }
    if (decay.intervalMs !== undefined && (!Number.isInteger(decay.intervalMs) || decay.intervalMs <= 0)) {
      throw new Error(`dreaming.decay.intervalMs must be a positive integer, got: ${decay.intervalMs}`);
    }
    if (decay.archiveThreshold !== undefined && (typeof decay.archiveThreshold !== 'number' || decay.archiveThreshold < 0 || decay.archiveThreshold > 1)) {
      throw new Error(`dreaming.decay.archiveThreshold must be a number between 0 and 1, got: ${decay.archiveThreshold}`);
    }
    const halfLifeDays = decay.halfLifeDays;
    if (halfLifeDays !== undefined) {
      for (const key of ['slow_decay', 'fast_decay'] as const) {
        const val = halfLifeDays[key];
        if (val !== undefined && (!Number.isInteger(val) || val <= 0)) {
          throw new Error(`dreaming.decay.halfLifeDays.${key} must be a positive integer, got: ${val}`);
        }
      }
    }
  }
}
```

- [ ] **Step 5: Add the `dreaming` block to `config/default.yaml`**

Add after the `intentDrift` block:

```yaml
# Dream engine — background knowledge graph maintenance (issue #27).
# The decay pass runs on a configurable interval and reduces the confidence of
# slow_decay and fast_decay nodes/edges using an exponential half-life model.
# When confidence drops to or below archiveThreshold, the row is soft-deleted
# (archived_at is set); it no longer appears in queries but is retained for audit.
#
# halfLifeDays: the number of days for a fact's confidence to halve.
#   permanent: null — these nodes are never touched by the decay pass.
#   slow_decay: 180  — employer, residence; reliable for months/years.
#   fast_decay: 21   — coffee preference, current focus; unreliable after weeks.
dreaming:
  decay:
    intervalMs: 86400000     # daily
    archiveThreshold: 0.05
    halfLifeDays:
      permanent: null
      slow_decay: 180
      fast_decay: 21
```

- [ ] **Step 6: Run config tests to verify they pass**

```bash
npm --prefix /path/to/worktree test src/config.dreaming.test.ts
```

Expected: all PASS.

- [ ] **Step 7: Run full test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git -C /path/to/worktree add src/config.ts src/config.dreaming.test.ts config/default.yaml
git -C /path/to/worktree commit -m "feat: add dreaming.decay config block (issue #27)"
```

---

## Task 4: Implement `DreamEngine`

**Files:**
- Create: `src/memory/dream-engine.ts`
- Create: `src/memory/dream-engine.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `src/memory/dream-engine.test.ts`:

```typescript
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
    const { pool, queries } = makePool([5, 3, 2, 1, 4]); // rowCounts for each query
    const engine = new DreamEngine(pool, makeBus(), createSilentLogger(), defaultConfig);
    const result = await engine.runDecayPass();

    // Should have executed: slow_decay nodes, fast_decay nodes, slow_decay edges, fast_decay edges, archive nodes, archive edges
    expect(queries.length).toBe(6);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not run any SQL for permanent nodes (halfLifeDays.permanent is null)', async () => {
    const { queries } = makePool();
    const engine = new DreamEngine(makePool().pool, makeBus(), createSilentLogger(), defaultConfig);
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix /path/to/worktree test src/memory/dream-engine.test.ts
```

Expected: FAIL — `DreamEngine` does not exist.

- [ ] **Step 3: Implement `DreamEngine`**

Create `src/memory/dream-engine.ts`:

```typescript
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';

// Config shape mirrors YamlConfig.dreaming.decay — all fields required at construction
// time (caller resolves defaults before passing in).
export interface DecayConfig {
  intervalMs: number;
  archiveThreshold: number;
  halfLifeDays: {
    permanent: null;
    slow_decay: number;
    fast_decay: number;
  };
}

export interface DecayPassResult {
  nodesDecayed: number;
  edgesDecayed: number;
  nodesArchived: number;
  edgesArchived: number;
  durationMs: number;
}

/**
 * DreamEngine — background knowledge graph maintenance.
 *
 * Named after the neuroscience analogy: sleep is when the brain consolidates
 * short-term experiences into long-term memory and prunes weak connections.
 *
 * Currently implements one pass: memory decay (issue #27).
 * Future passes (decay warning #280, contradiction resolution, synthesis) will
 * be added as sibling methods with their own config keys under `dreaming`.
 *
 * EventBus is injected now but unused — reserved for the decay warning pass (#280)
 * which will emit `memory.decay_warning` before archiving important nodes.
 */
export class DreamEngine {
  private pool: Pool;
  // EventBus reserved for decay warning pass (issue #280) — injected now so the
  // constructor signature doesn't need to change when that feature lands.
  private _bus: EventBus;
  private logger: Logger;
  private config: DecayConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(pool: Pool, bus: EventBus, logger: Logger, config: DecayConfig) {
    this.pool = pool;
    this._bus = bus;
    this.logger = logger;
    this.config = config;
  }

  /**
   * Start the recurring decay interval.
   * Logs the configured cadence so operators can verify the schedule at startup.
   */
  start(): void {
    this.intervalHandle = setInterval(() => {
      this.runDecayPass().catch((err) => {
        this.logger.error({ err }, 'DreamEngine: unhandled error in runDecayPass');
      });
    }, this.config.intervalMs);

    this.logger.info(
      { intervalMs: this.config.intervalMs, archiveThreshold: this.config.archiveThreshold },
      'DreamEngine started (decay pass scheduled)',
    );
  }

  /** Stop the interval timer for clean shutdown. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.logger.info('DreamEngine stopped');
  }

  /**
   * Run one full decay pass:
   *   1. Decay confidence on slow_decay and fast_decay nodes and edges
   *   2. Archive nodes whose confidence is at or below archiveThreshold
   *   3. Archive edges whose endpoints were archived, or whose own confidence crossed the threshold
   */
  async runDecayPass(): Promise<DecayPassResult> {
    const start = Date.now();
    this.logger.info('DreamEngine: decay pass starting');

    const { archiveThreshold, halfLifeDays } = this.config;

    // Pass 1a: Decay slow_decay nodes
    // confidence × 0.5^(days_since_confirmed / half_life_days)
    // The guard confidence > archiveThreshold skips already-condemned rows to avoid
    // unnecessary writes — they will be archived in Pass 2 regardless.
    const slowNodeResult = await this.pool.query(
      `UPDATE kg_nodes
         SET confidence = confidence * power(0.5,
             EXTRACT(EPOCH FROM (now() - last_confirmed_at)) / 86400.0 / $1)
       WHERE archived_at IS NULL
         AND decay_class = $2
         AND confidence > $3`,
      [halfLifeDays.slow_decay, 'slow_decay', archiveThreshold],
    );

    // Pass 1b: Decay fast_decay nodes
    const fastNodeResult = await this.pool.query(
      `UPDATE kg_nodes
         SET confidence = confidence * power(0.5,
             EXTRACT(EPOCH FROM (now() - last_confirmed_at)) / 86400.0 / $1)
       WHERE archived_at IS NULL
         AND decay_class = $2
         AND confidence > $3`,
      [halfLifeDays.fast_decay, 'fast_decay', archiveThreshold],
    );

    // Pass 1c: Decay slow_decay edges
    const slowEdgeResult = await this.pool.query(
      `UPDATE kg_edges
         SET confidence = confidence * power(0.5,
             EXTRACT(EPOCH FROM (now() - last_confirmed_at)) / 86400.0 / $1)
       WHERE archived_at IS NULL
         AND decay_class = $2
         AND confidence > $3`,
      [halfLifeDays.slow_decay, 'slow_decay', archiveThreshold],
    );

    // Pass 1d: Decay fast_decay edges
    const fastEdgeResult = await this.pool.query(
      `UPDATE kg_edges
         SET confidence = confidence * power(0.5,
             EXTRACT(EPOCH FROM (now() - last_confirmed_at)) / 86400.0 / $1)
       WHERE archived_at IS NULL
         AND decay_class = $2
         AND confidence > $3`,
      [halfLifeDays.fast_decay, 'fast_decay', archiveThreshold],
    );

    const nodesDecayed = (slowNodeResult.rowCount ?? 0) + (fastNodeResult.rowCount ?? 0);
    const edgesDecayed = (slowEdgeResult.rowCount ?? 0) + (fastEdgeResult.rowCount ?? 0);

    // Pass 2: Archive nodes at or below threshold (permanent nodes are never archived)
    const archiveNodeResult = await this.pool.query(
      `UPDATE kg_nodes
         SET archived_at = now()
       WHERE archived_at IS NULL
         AND decay_class != 'permanent'
         AND confidence <= $1`,
      [archiveThreshold],
    );

    const nodesArchived = archiveNodeResult.rowCount ?? 0;

    // Pass 3: Archive edges whose endpoint was just archived, OR whose own confidence
    // is at or below threshold. Using archived_at IS NOT NULL for nodes catches both
    // the just-archived nodes from Pass 2 and any previously archived nodes, ensuring
    // no edge is left dangling to an archived endpoint.
    const archiveEdgeResult = await this.pool.query(
      `UPDATE kg_edges
         SET archived_at = now()
       WHERE archived_at IS NULL
         AND (
           confidence <= $1
           OR source_node_id IN (SELECT id FROM kg_nodes WHERE archived_at IS NOT NULL)
           OR target_node_id IN (SELECT id FROM kg_nodes WHERE archived_at IS NOT NULL)
         )`,
      [archiveThreshold],
    );

    const edgesArchived = archiveEdgeResult.rowCount ?? 0;
    const durationMs = Date.now() - start;

    this.logger.info(
      { nodesDecayed, edgesDecayed, nodesArchived, edgesArchived, durationMs },
      'DreamEngine: decay pass complete',
    );

    return { nodesDecayed, edgesDecayed, nodesArchived, edgesArchived, durationMs };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix /path/to/worktree test src/memory/dream-engine.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/memory/dream-engine.ts src/memory/dream-engine.test.ts
git -C /path/to/worktree commit -m "feat: implement DreamEngine with memory decay pass (issue #27)"
```

---

## Task 5: Wire `DreamEngine` into `Scheduler` and `index.ts`

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add `dreamEngine` to `SchedulerConfig` and `Scheduler`**

In `src/scheduler/scheduler.ts`, import `DreamEngine`:

```typescript
import type { DreamEngine } from '../memory/dream-engine.js';
```

Add `dreamEngine` to `SchedulerConfig` (around line 76):

```typescript
/** Dream engine for background KG maintenance. When absent, no background decay runs. */
dreamEngine?: DreamEngine;
```

Add the field to the `Scheduler` class (after `driftDetector`, around line 90):

```typescript
private dreamEngine?: DreamEngine;
```

Set it in the constructor (after `this.driftDetector = config.driftDetector`):

```typescript
this.dreamEngine = config.dreamEngine;
```

- [ ] **Step 2: Start and stop the `DreamEngine` alongside the scheduler**

In `Scheduler.start()`, after the watchdog `setInterval` block (around line 152):

```typescript
// Dream engine — background KG maintenance (decay, and future passes).
if (this.dreamEngine) {
  this.dreamEngine.start();
}
```

In `Scheduler.stop()`, after clearing `watchdogHandle` (around line 165):

```typescript
if (this.dreamEngine) {
  this.dreamEngine.stop();
}
```

- [ ] **Step 3: Construct `DreamEngine` in `index.ts`**

In `src/index.ts`, add the import near the other memory imports:

```typescript
import { DreamEngine } from './memory/dream-engine.js';
import type { DecayConfig } from './memory/dream-engine.js';
```

After the `driftDetector` construction block (around line 685), add:

```typescript
// Dream engine — background KG maintenance (spec 17 / issue #27).
// Defaults are intentionally conservative: daily cadence, 5% archive threshold,
// 180-day slow-decay half-life, 21-day fast-decay half-life.
const decayConfig: DecayConfig = {
  intervalMs: yamlConfig.dreaming?.decay?.intervalMs ?? 86_400_000,
  archiveThreshold: yamlConfig.dreaming?.decay?.archiveThreshold ?? 0.05,
  halfLifeDays: {
    permanent: null,
    slow_decay: yamlConfig.dreaming?.decay?.halfLifeDays?.slow_decay ?? 180,
    fast_decay: yamlConfig.dreaming?.decay?.halfLifeDays?.fast_decay ?? 21,
  },
};
const dreamEngine = new DreamEngine(pool, bus, logger, decayConfig);
logger.info({ decayConfig }, 'DreamEngine configured');
```

Pass `dreamEngine` to the `Scheduler` constructor (around line 687):

```typescript
const scheduler = new Scheduler({ pool, bus, logger, schedulerService, driftDetector, dreamEngine });
```

- [ ] **Step 4: Run the full test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/scheduler/scheduler.ts src/index.ts
git -C /path/to/worktree commit -m "feat: wire DreamEngine into Scheduler start/stop (issue #27)"
```

---

## Task 6: Integration tests

**Files:**
- Create: `tests/integration/dream-engine.test.ts`

- [ ] **Step 1: Write integration tests**

Create `tests/integration/dream-engine.test.ts`:

```typescript
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
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM kg_edges');
    await pool.query('DELETE FROM kg_nodes');
    await pool.end();
  });

  it('decays confidence on a fast_decay node based on age', async () => {
    // Insert a node whose last_confirmed_at is 21 days ago (one full half-life)
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
    // Allow ±0.02 tolerance for floating point.
    expect(result.rows[0]!.confidence).toBeCloseTo(0.4, 1);
  });

  it('archives a node whose confidence falls at or below archiveThreshold', async () => {
    // Insert a node already at the threshold
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
    // Insert a node and manually archive it, then check search excludes it
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

    // Archive node a directly to simulate decay pass
    await pool.query('UPDATE kg_nodes SET archived_at = now() WHERE id = $1', [a.id]);

    // Run the pass — Pass 3 should cascade to the edge
    await engine.runDecayPass();

    const { rows } = await pool.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM kg_edges WHERE id = $1',
      [edge.id],
    );
    expect(rows[0]!.archived_at).not.toBeNull();
  });

  it('does not archive permanent nodes regardless of age', async () => {
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
```

- [ ] **Step 2: Run integration tests (requires DATABASE_URL)**

```bash
DATABASE_URL=postgres://localhost/curia_test npm --prefix /path/to/worktree test tests/integration/dream-engine.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run full test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add tests/integration/dream-engine.test.ts
git -C /path/to/worktree commit -m "test: add DreamEngine integration tests (issue #27)"
```

---

## Task 7: Update CHANGELOG and version, then open PR

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Check current version**

```bash
grep '"version"' /path/to/worktree/package.json
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Under `## [Unreleased]`, add:

```markdown
### Added
- **Dream Engine** (spec 17): background KG maintenance system with memory decay pass. Confidence on `slow_decay` and `fast_decay` nodes/edges decays exponentially using configurable half-lives (180 days / 21 days). Rows at or below the archive threshold are soft-deleted via `archived_at`; edges cascade when their endpoints are archived. All KG read paths filter archived rows. Wired as an internal system job in the Scheduler. Config under `dreaming.decay.*` in `config/default.yaml`. Implements issue #27; decay warning (#280) deferred to a follow-up.
```

- [ ] **Step 3: Bump version in `package.json`**

This is the first time spec 17 ships, so bump minor (e.g. `0.X.0 → 0.(X+1).0`):

```bash
npm --prefix /path/to/worktree version minor --no-git-tag-version
```

- [ ] **Step 4: Commit changelog and version**

```bash
git -C /path/to/worktree add CHANGELOG.md package.json
git -C /path/to/worktree commit -m "chore: changelog and version bump for dream engine (issue #27)"
```

- [ ] **Step 5: Open PR**

```bash
gh pr create --repo josephfung/curia \
  --base main \
  --head feat/dream-engine \
  --title "feat: Dream Engine — memory decay pass (issue #27)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `DreamEngine` class (`src/memory/dream-engine.ts`) with a configurable exponential confidence decay pass
- Adds `archived_at` column to `kg_nodes` and `kg_edges` (migration 024); all KG read paths filter archived rows
- Configurable under `dreaming.decay.*` in `config/default.yaml` (half-lives: 180 days slow, 21 days fast; archive threshold: 0.05)
- EventBus injected but unused — reserved for decay warning follow-up (#280)
- Closes #27

## Test plan

- [ ] Unit tests pass: `npm test src/memory/dream-engine.test.ts`
- [ ] KG filter tests pass: `npm test src/memory/dream-engine-kg-filter.test.ts`
- [ ] Config validation tests pass: `npm test src/config.dreaming.test.ts`
- [ ] Integration tests pass (requires DATABASE_URL): `npm test tests/integration/dream-engine.test.ts`
- [ ] Full test suite passes: `npm test`
- [ ] Migration applied cleanly to local DB
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `archived_at` column on both tables + partial indexes | Task 1 |
| All read paths filter `WHERE archived_at IS NULL` | Task 2 |
| Config block `dreaming.decay.*` in YAML + validation | Task 3 |
| `DreamEngine` class with `runDecayPass()` | Task 4 |
| Pass 1: exponential decay on `slow_decay`/`fast_decay` nodes and edges | Task 4 |
| Pass 2: archive nodes ≤ archiveThreshold | Task 4 |
| Pass 3: archive edges with archived endpoints or own confidence ≤ threshold | Task 4 |
| `permanent` nodes never touched | Task 4 |
| `EventBus` injected, unused, reserved for #280 | Task 4 |
| `DreamEngine` wired into `Scheduler.start()` / `stop()` | Task 5 |
| Config resolved with defaults in `index.ts` | Task 5 |
| Unit tests: decay math, pass counts, permanent skip | Task 4 |
| Integration tests: real Postgres, age-based decay, archiving, read path exclusion | Task 6 |

**Upsert edge case (Task 2, Step 8):** The plan notes to check `016_kg_node_uniqueness.sql` for the exact index name before writing the DROP — this is a reminder, not a TBD. The implementer must do this lookup before executing Step 8.

**Type consistency:** `DecayConfig`, `DecayPassResult`, `DreamEngine` — used consistently across Tasks 3, 4, and 5.
