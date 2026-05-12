# Decay Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a warn phase to DreamEngine that flags important KG nodes before archiving, holds them for 7 days, and lets the coordinator surface a re-confirmation nudge to the CEO.

**Architecture:** DreamEngine gains three new passes: (1) a percentile-based warn pass that sets `warned_at` on high-sensitivity and high-connectivity nodes approaching the archive threshold, (2) a modified archive pass that honours the 7-day hold-back window, and (3) an expired-warning archive pass. Two new skills (`decay-warnings-list`, `memory-confirm`) let the coordinator discover warned nodes and record the CEO's confirm/dismiss response. The coordinator prompt is updated with the same proactive-check pattern used for held messages.

**Tech Stack:** PostgreSQL 16+ with node-postgres, TypeScript (ESM), Vitest, existing EventBus + skill execution infrastructure.

---

## File Map

**New files:**
- `src/db/migrations/037_add_kg_nodes_warned_at.sql` — schema: `warned_at`, `warn_reason`, partial index
- `skills/decay-warnings-list/skill.json` — skill manifest
- `skills/decay-warnings-list/handler.ts` — list warned nodes
- `skills/decay-warnings-list/handler.test.ts` — unit tests
- `skills/memory-confirm/skill.json` — skill manifest
- `skills/memory-confirm/handler.ts` — confirm or dismiss a warned node
- `skills/memory-confirm/handler.test.ts` — unit tests

**Modified files:**
- `src/bus/events.ts` — add `MemoryDecayWarningPayload`, `MemoryDecayWarningEvent`, `createMemoryDecayWarning`, add to `BusEvent` union
- `src/bus/permissions.ts` — add `memory.decay_warning` to system publish/subscribe allowlists
- `src/memory/knowledge-graph.ts` — add `confirmDecayWarning`, `dismissDecayWarning`, `listDecayWarnings` to `KnowledgeGraphBackend` interface, `PgBackend`, `InMemoryBackend`, and `KnowledgeGraphStore`
- `src/memory/entity-memory.ts` — expose the three new methods
- `src/memory/dream-engine.ts` — store `bus`, extend `DecayConfig`, implement warn pass and modified archive passes
- `src/memory/dream-engine.test.ts` — new tests for the warn pass and archive-pass changes
- `config/default.yaml` — add `edgeCountPercentile`, `edgeCountFloor`, `warnHoldBackDays` under `dreaming.decay`
- `src/index.ts` — wire new config fields into `decayConfig`
- `agents/coordinator.yaml` — add decay warning prompt section and `pinned_skills` entries
- `CHANGELOG.md` — add unreleased entries

---

## Task 1: Database migration

**Files:**
- Create: `src/db/migrations/037_add_kg_nodes_warned_at.sql`

Adds `warned_at` (when the node was flagged) and `warn_reason` (why it was flagged). The partial index makes the `decay-warnings-list` query fast — it only covers the small number of actively-warned, non-archived nodes.

- [ ] **Step 1: Write the migration**

```sql
-- 037_add_kg_nodes_warned_at.sql
-- Adds decay-warning state to kg_nodes.
-- warned_at: when DreamEngine flagged this node for CEO re-confirmation.
-- warn_reason: why it was flagged (high_sensitivity, high_connectivity, or both).
ALTER TABLE kg_nodes ADD COLUMN warned_at TIMESTAMPTZ;
ALTER TABLE kg_nodes ADD COLUMN warn_reason TEXT
  CHECK (warn_reason IN ('high_sensitivity', 'high_connectivity', 'both'));

-- Partial index: only covers actively-warned, non-archived nodes.
-- Keeps the decay-warnings-list skill query fast as the graph scales.
CREATE INDEX idx_kg_nodes_warned
  ON kg_nodes (warned_at)
  WHERE warned_at IS NOT NULL AND archived_at IS NULL;
```

- [ ] **Step 2: Verify the migration runs cleanly**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run db:migrate
```

Expected: migration 037 applied, no errors.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add src/db/migrations/037_add_kg_nodes_warned_at.sql
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "feat: add warned_at and warn_reason columns to kg_nodes (#280)"
```

---

## Task 2: Bus event + permissions

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`

Adds the `memory.decay_warning` event type that DreamEngine emits for the audit trail.

- [ ] **Step 1: Add payload interface and event interface to `src/bus/events.ts`**

After the existing `MemoryQueryEvent` block (around line 575), add:

```typescript
// memory.decay_warning — emitted by DreamEngine (system layer) when an important
// KG node is flagged for CEO re-confirmation before archival (#280).
// "important" = high sensitivity (confidential/restricted) OR high edge-count (top p95, floor 5).
export interface MemoryDecayWarningPayload {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  confidence: number;
  sensitivity: Sensitivity;
  edgeCount: number;
  /** Why this node was flagged as important. */
  reason: 'high_sensitivity' | 'high_connectivity' | 'both';
}

export interface MemoryDecayWarningEvent extends BaseEvent {
  type: 'memory.decay_warning';
  sourceLayer: 'system';
  payload: MemoryDecayWarningPayload;
}
```

Note: `NodeType` is already imported at the top of `events.ts` via `import type { Sensitivity } from '../memory/types.js'`. You need to add `NodeType` to that import:

```typescript
import type { Sensitivity, NodeType } from '../memory/types.js';
```

- [ ] **Step 2: Add `MemoryDecayWarningEvent` to the `BusEvent` union**

In the `BusEvent` union (around line 674), add after the `MemoryQueryEvent` line:

```typescript
  | MemoryDecayWarningEvent  // #280: DreamEngine flags important node for CEO re-confirmation
```

- [ ] **Step 3: Add the factory function to `src/bus/events.ts`**

Near the end of the file, after `createMemoryQuery`:

```typescript
export function createMemoryDecayWarning(
  payload: MemoryDecayWarningPayload & { parentEventId?: string },
): MemoryDecayWarningEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'memory.decay_warning',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 4: Add `memory.decay_warning` to the system layer in `src/bus/permissions.ts`**

In the comment block at the top, add a line:
```typescript
// #280 (decay warning): system layer publishes memory.decay_warning when DreamEngine
//          flags an important node for CEO re-confirmation before archival.
```

In `publishAllowlist`, add `'memory.decay_warning'` to the system Set.
In `subscribeAllowlist`, add `'memory.decay_warning'` to the system Set.

The system set in `publishAllowlist` is on line 30. Add to it:
```
'memory.decay_warning'
```

And the same to the system set in `subscribeAllowlist` on line 39.

- [ ] **Step 5: Check TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add src/bus/events.ts src/bus/permissions.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "feat: add memory.decay_warning bus event type (#280)"
```

---

## Task 3: DecayConfig extensions + config wiring

**Files:**
- Modify: `src/memory/dream-engine.ts`
- Modify: `config/default.yaml`
- Modify: `src/index.ts`

Adds the three new config fields before touching any logic.

- [ ] **Step 1: Extend `DecayConfig` in `src/memory/dream-engine.ts`**

Replace the existing `DecayConfig` interface (lines 8–16):

```typescript
export interface DecayConfig {
  intervalMs: number;
  archiveThreshold: number;
  halfLifeDays: {
    permanent: null;
    slow_decay: number;
    fast_decay: number;
  };
  /** Percentile (0–1) used to compute the edge-count threshold for "high connectivity".
   *  A node is high-connectivity if its edge count >= percentile_disc(edgeCountPercentile)
   *  across all non-archived nodes, subject to edgeCountFloor. Default: 0.95 (top 5%). */
  edgeCountPercentile: number;
  /** Minimum edge count for the high-connectivity criterion regardless of percentile.
   *  Prevents warnings on trivially-connected nodes in a sparse graph. Default: 5. */
  edgeCountFloor: number;
  /** Days a warned node is held back from archiving while awaiting CEO re-confirmation.
   *  After this window, the node is archived by the next decay pass. Default: 7. */
  warnHoldBackDays: number;
}
```

- [ ] **Step 2: Add defaults to `config/default.yaml`**

Find the `dreaming.decay` section (around line 234) and add the three new keys:

```yaml
dreaming:
  decay:
    intervalMs: 86400000     # daily
    archiveThreshold: 0.05
    halfLifeDays:
      permanent: ~
      slow_decay: 180
      fast_decay: 21
    # Decay warning (#280): warn important nodes before archiving.
    # A node is "important" if it has high sensitivity (confidential/restricted)
    # OR high connectivity (edge count >= p95 of all nodes, floor 5).
    edgeCountPercentile: 0.95  # top 5% by edge count triggers a warning
    edgeCountFloor: 5           # minimum edge count threshold regardless of percentile
    warnHoldBackDays: 7         # days to hold a warned node before archiving anyway
```

- [ ] **Step 3: Wire new config fields in `src/index.ts`**

Find the `decayConfig` construction (around line 860) and add the three new fields:

```typescript
const decayConfig: DecayConfig = {
  intervalMs: yamlConfig.dreaming?.decay?.intervalMs ?? 86_400_000,
  archiveThreshold: yamlConfig.dreaming?.decay?.archiveThreshold ?? 0.05,
  halfLifeDays: {
    permanent: null,
    slow_decay: yamlConfig.dreaming?.decay?.halfLifeDays?.slow_decay ?? 180,
    fast_decay: yamlConfig.dreaming?.decay?.halfLifeDays?.fast_decay ?? 21,
  },
  edgeCountPercentile: yamlConfig.dreaming?.decay?.edgeCountPercentile ?? 0.95,
  edgeCountFloor: yamlConfig.dreaming?.decay?.edgeCountFloor ?? 5,
  warnHoldBackDays: yamlConfig.dreaming?.decay?.warnHoldBackDays ?? 7,
};
```

- [ ] **Step 4: Check TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add src/memory/dream-engine.ts config/default.yaml src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "feat: extend DecayConfig with edgeCountPercentile, edgeCountFloor, warnHoldBackDays (#280)"
```

---

## Task 4: KnowledgeGraphStore + EntityMemory new methods

**Files:**
- Modify: `src/memory/knowledge-graph.ts`
- Modify: `src/memory/entity-memory.ts`

Adds three methods that the skill handlers will call via `ctx.entityMemory`. These go directly through the existing layer stack: `EntityMemory → KnowledgeGraphStore → PgBackend`.

- [ ] **Step 1: Add types for the new methods**

At the top of `src/memory/knowledge-graph.ts`, after the existing interfaces, add:

```typescript
/** Returned by listDecayWarnings — one entry per warned node. */
export interface DecayWarningRow {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  confidence: number;
  sensitivity: Sensitivity;
  edgeCount: number;
  reason: 'high_sensitivity' | 'high_connectivity' | 'both';
  warnedAt: Date;
}

/** Returned by confirmDecayWarning and dismissDecayWarning. */
export interface DecayWarningActionResult {
  success: boolean;
  /** The node's label, included so the skill can confirm back to the coordinator. */
  label?: string;
}
```

- [ ] **Step 2: Add three methods to `KnowledgeGraphBackend` interface**

In the `KnowledgeGraphBackend` interface (ending around line 78), add after `semanticSearch`:

```typescript
  /** List all warned (warned_at IS NOT NULL), non-archived nodes, sorted oldest-first. */
  listDecayWarnings(): Promise<DecayWarningRow[]>;
  /** Confirm a warned node: reset last_confirmed_at = NOW(), confidence = 1.0, warned_at = NULL.
   *  Returns success: false if the node is not in a warned state. */
  confirmDecayWarning(nodeId: string): Promise<DecayWarningActionResult>;
  /** Dismiss a warned node: set archived_at = NOW(), warned_at = NULL.
   *  Returns success: false if the node is not in a warned state. */
  dismissDecayWarning(nodeId: string): Promise<DecayWarningActionResult>;
```

- [ ] **Step 3: Implement the three methods in `PgBackend`**

Find the `PgBackend` class (around line 330). Add these methods after `semanticSearch`:

```typescript
async listDecayWarnings(): Promise<DecayWarningRow[]> {
  const result = await this.pool.query<{
    id: string;
    type: NodeType;
    label: string;
    confidence: number;
    sensitivity: Sensitivity;
    edge_count: string;  // pg returns bigint counts as strings
    warn_reason: 'high_sensitivity' | 'high_connectivity' | 'both';
    warned_at: Date;
  }>(
    `SELECT n.id, n.type, n.label, n.confidence, n.sensitivity,
            n.warn_reason,
            n.warned_at,
            COUNT(e.id) AS edge_count
       FROM kg_nodes n
       LEFT JOIN kg_edges e ON (e.source_node_id = n.id OR e.target_node_id = n.id)
                             AND e.archived_at IS NULL
      WHERE n.warned_at IS NOT NULL
        AND n.archived_at IS NULL
      GROUP BY n.id, n.type, n.label, n.confidence, n.sensitivity,
               n.warn_reason, n.warned_at
      ORDER BY n.warned_at ASC`,
  );
  return result.rows.map(row => ({
    nodeId: row.id,
    nodeType: row.type,
    label: row.label,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    edgeCount: parseInt(row.edge_count, 10),
    reason: row.warn_reason,
    warnedAt: row.warned_at,
  }));
}

async confirmDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
  const result = await this.pool.query<{ label: string }>(
    `UPDATE kg_nodes
        SET last_confirmed_at = NOW(),
            confidence = 1.0,
            warned_at = NULL,
            warn_reason = NULL
      WHERE id = $1
        AND warned_at IS NOT NULL
        AND archived_at IS NULL
      RETURNING label`,
    [nodeId],
  );
  if (!result.rows[0]) return { success: false };
  return { success: true, label: result.rows[0].label };
}

async dismissDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
  const result = await this.pool.query<{ label: string }>(
    `UPDATE kg_nodes
        SET archived_at = NOW(),
            warned_at = NULL,
            warn_reason = NULL
      WHERE id = $1
        AND warned_at IS NOT NULL
        AND archived_at IS NULL
      RETURNING label`,
    [nodeId],
  );
  if (!result.rows[0]) return { success: false };
  return { success: true, label: result.rows[0].label };
}
```

- [ ] **Step 4: Implement stubs in `InMemoryBackend`**

`InMemoryBackend` needs to track `warned_at` and `warn_reason` for in-memory test usage. Find `InMemoryBackend` (around line 754) and:

Add two new Maps to the class fields:
```typescript
// warned state — tracks nodeId → { warnedAt, reason } for decay warning tests
private warnedNodes = new Map<string, { warnedAt: Date; reason: 'high_sensitivity' | 'high_connectivity' | 'both' }>();
```

Then add the three methods at the end of the class:
```typescript
async listDecayWarnings(): Promise<DecayWarningRow[]> {
  const rows: DecayWarningRow[] = [];
  for (const [nodeId, warnState] of this.warnedNodes) {
    if (this.archivedNodes.has(nodeId)) continue;
    const node = this.nodes.get(nodeId);
    if (!node) continue;
    const edgeCount = Array.from(this.edges.values()).filter(
      e => !this.archivedEdges.has(e.id) && (e.sourceNodeId === nodeId || e.targetNodeId === nodeId),
    ).length;
    rows.push({
      nodeId,
      nodeType: node.type,
      label: node.label,
      confidence: node.temporal.confidence,
      sensitivity: node.sensitivity,
      edgeCount,
      reason: warnState.reason,
      warnedAt: warnState.warnedAt,
    });
  }
  return rows.sort((a, b) => a.warnedAt.getTime() - b.warnedAt.getTime());
}

async confirmDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
  if (!this.warnedNodes.has(nodeId) || this.archivedNodes.has(nodeId)) {
    return { success: false };
  }
  const node = this.nodes.get(nodeId);
  if (!node) return { success: false };
  this.warnedNodes.delete(nodeId);
  this.nodes.set(nodeId, {
    ...node,
    temporal: { ...node.temporal, lastConfirmedAt: new Date(), confidence: 1.0 },
  });
  return { success: true, label: node.label };
}

async dismissDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
  if (!this.warnedNodes.has(nodeId) || this.archivedNodes.has(nodeId)) {
    return { success: false };
  }
  const node = this.nodes.get(nodeId);
  if (!node) return { success: false };
  this.warnedNodes.delete(nodeId);
  this.archivedNodes.add(nodeId);
  return { success: true, label: node.label };
}
```

- [ ] **Step 5: Expose on `KnowledgeGraphStore`**

In the `KnowledgeGraphStore` class (around line 89), add after the existing public methods:

```typescript
/** List all warned (warned_at IS NOT NULL), non-archived nodes for the CEO re-confirmation flow. */
async listDecayWarnings(): Promise<DecayWarningRow[]> {
  return this.backend.listDecayWarnings();
}

/** Confirm a warned node: reset decay clock (last_confirmed_at = NOW(), confidence = 1.0), clear warned_at. */
async confirmDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
  return this.backend.confirmDecayWarning(nodeId);
}

/** Dismiss a warned node: archive it immediately, clear warned_at. */
async dismissDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
  return this.backend.dismissDecayWarning(nodeId);
}
```

- [ ] **Step 6: Expose on `EntityMemory`**

In `src/memory/entity-memory.ts`, add three methods delegating to `this.store`. Add after the last public method:

```typescript
/** List KG nodes flagged for CEO re-confirmation by the decay warning pass. */
async listDecayWarnings(): Promise<import('./knowledge-graph.js').DecayWarningRow[]> {
  return this.store.listDecayWarnings();
}

/** Confirm a warned node: reset its decay clock. Called when the CEO verifies the fact is still current. */
async confirmDecayWarning(nodeId: string): Promise<import('./knowledge-graph.js').DecayWarningActionResult> {
  return this.store.confirmDecayWarning(nodeId);
}

/** Dismiss a warned node: archive it immediately. Called when the CEO says it's no longer relevant. */
async dismissDecayWarning(nodeId: string): Promise<import('./knowledge-graph.js').DecayWarningActionResult> {
  return this.store.dismissDecayWarning(nodeId);
}
```

- [ ] **Step 7: Check TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add src/memory/knowledge-graph.ts src/memory/entity-memory.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "feat: add listDecayWarnings, confirmDecayWarning, dismissDecayWarning to KG store (#280)"
```

---

## Task 5: DreamEngine — warn pass (TDD)

**Files:**
- Modify: `src/memory/dream-engine.ts`
- Modify: `src/memory/dream-engine.test.ts`

Implements the core of the feature. Uses TDD: write tests first, then make them pass.

The existing `makePool` mock returns `rows: []` for all queries. The warn pass uses `RETURNING`, so we need a richer mock. Add a new helper `makePoolWithResponses` alongside `makePool` in the test file.

- [ ] **Step 1: Write the failing tests for the warn pass**

Add this block to `src/memory/dream-engine.test.ts` after the existing `describe` blocks:

```typescript
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
  edgeCountPercentile: 0.95,
  edgeCountFloor: 5,
  warnHoldBackDays: 7,
};

describe('DreamEngine warn pass', () => {
  it('emits memory.decay_warning for each newly warned node', async () => {
    // Query order: 1a slow nodes, 1b fast nodes, 1c slow edges, 1d fast edges,
    //   percentile threshold (rows: [{threshold: 10}]),
    //   warn UPDATE RETURNING (rows: two warned nodes),
    //   archive expired warnings (rowCount: 0),
    //   archive regular nodes (rowCount: 0),
    //   archive edges (rowCount: 0)
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
    // First call: node-1 (high_sensitivity)
    const firstCall = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[0]).toBe('system');
    expect(firstCall[1].type).toBe('memory.decay_warning');
    expect(firstCall[1].payload.nodeId).toBe('node-1');
    expect(firstCall[1].payload.reason).toBe('high_sensitivity');
    // Second call: node-2 (high_connectivity)
    const secondCall = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[1].payload.nodeId).toBe('node-2');
    expect(secondCall[1].payload.reason).toBe('high_connectivity');
  });

  it('does not emit events when no nodes are warned', async () => {
    const { pool } = makePoolWithResponses([
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
      { rows: [{ threshold: 10 }] },
      { rowCount: 0, rows: [] },  // warn pass: no rows
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

    // 5th data query (index 4 after BEGIN) is the threshold query
    const thresholdQuery = queries.find(q => q.sql.includes('percentile_disc'));
    expect(thresholdQuery).toBeDefined();
    expect(thresholdQuery!.params).toContain(0.95);  // edgeCountPercentile
    expect(thresholdQuery!.params).toContain(5);      // edgeCountFloor
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
    expect(warnQuery!.sql).toMatch(/HAVING/);  // edge count filter in HAVING
  });

  it('returns nodesExpired count from expired-warning archive pass', async () => {
    const { pool } = makePoolWithResponses([
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 },
      { rows: [{ threshold: 10 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 3 },   // expire stale warnings: 3 nodes archived
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

    // The regular archive pass (Pass 2b) must exclude nodes with warned_at IS NOT NULL
    const regularArchiveQuery = queries.filter(q =>
      q.sql.includes('kg_nodes') && q.sql.includes('archived_at = now()'),
    );
    // There should be two archive queries: Pass 2a (expire warnings) and Pass 2b (regular)
    expect(regularArchiveQuery.length).toBeGreaterThanOrEqual(2);
    // Pass 2b (the second archive nodes query) must have warned_at IS NULL in WHERE
    const pass2b = regularArchiveQuery[regularArchiveQuery.length - 1]!;
    expect(pass2b.sql).toMatch(/warned_at IS NULL/);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning test src/memory/dream-engine.test.ts 2>&1 | tail -30
```

Expected: tests in `DreamEngine warn pass` fail (feature not yet implemented).

- [ ] **Step 3: Implement the warn pass in `src/memory/dream-engine.ts`**

First, update the constructor to store the bus:

```typescript
// Replace the constructor — store bus instead of discarding it
constructor(pool: Pool, bus: EventBus, logger: Logger, config: DecayConfig, scoringPass?: AutonomyScoringPass) {
  this.pool = pool;
  this.bus = bus;
  this.logger = logger;
  this.config = config;
  this.scoringPass = scoringPass;
}
```

Add `private bus: EventBus;` to the class fields (alongside `private pool`, etc.).

Update the import at the top to include the factory:
```typescript
import { createMemoryDecayWarning } from '../bus/events.js';
```

Update `_runDecayPassOnClient` signature and return type. First update `DecayPassResult`:
```typescript
export interface DecayPassResult {
  nodesDecayed: number;
  edgesDecayed: number;
  nodesWarned: number;    // nodes newly flagged in this pass
  nodesExpired: number;   // warned nodes archived because hold-back expired
  nodesArchived: number;
  edgesArchived: number;
  durationMs: number;
}
```

Then in `_runDecayPassOnClient`, after passes 1a–1d, add:

```typescript
// Pass 1.5: Warn pass — flag important nodes approaching archive threshold.
// "Important" = high sensitivity (confidential/restricted) OR high edge-count.
// Edge-count threshold is computed dynamically as the p95 of all non-archived
// nodes, with a floor of edgeCountFloor, so the bar stays calibrated as the
// graph grows.
//
// Uses a CTE with HAVING so the edge-count aggregate can be used in the filter
// without a subquery. RETURNING gives us the warned rows for bus event emission.

// Step 1: compute the edge-count threshold for this pass
const thresholdResult = await client.query<{ threshold: number }>(
  `SELECT GREATEST(
     (SELECT percentile_disc($1) WITHIN GROUP (ORDER BY edge_count)
        FROM (
          SELECT n.id, COUNT(e.id) AS edge_count
            FROM kg_nodes n
            LEFT JOIN kg_edges e
              ON (e.source_node_id = n.id OR e.target_node_id = n.id)
             AND e.archived_at IS NULL
           WHERE n.archived_at IS NULL
           GROUP BY n.id
        ) sub
     ),
     $2
   ) AS threshold`,
  [this.config.edgeCountPercentile, this.config.edgeCountFloor],
);
const edgeCountThreshold = thresholdResult.rows[0]?.threshold ?? this.config.edgeCountFloor;

// Step 2: flag important nodes (skip already-warned nodes for idempotency)
const warnResult = await client.query<{
  id: string;
  type: string;
  label: string;
  confidence: number;
  sensitivity: string;
  edge_count: string;
  warn_reason: string;
  warned_at: Date;
}>(
  `WITH candidates AS (
     SELECT n.id, n.type, n.label, n.confidence, n.sensitivity,
            COUNT(e.id) AS edge_count,
            CASE
              WHEN n.sensitivity IN ('confidential', 'restricted')
               AND COUNT(e.id) >= $4 THEN 'both'
              WHEN n.sensitivity IN ('confidential', 'restricted') THEN 'high_sensitivity'
              ELSE 'high_connectivity'
            END AS reason
       FROM kg_nodes n
       LEFT JOIN kg_edges e
              ON (e.source_node_id = n.id OR e.target_node_id = n.id)
             AND e.archived_at IS NULL
      WHERE n.archived_at IS NULL
        AND n.warned_at IS NULL
        AND n.decay_class != 'permanent'
        AND n.confidence <= $1
      GROUP BY n.id, n.type, n.label, n.confidence, n.sensitivity
     HAVING n.sensitivity IN ('confidential', 'restricted')
         OR COUNT(e.id) >= $4
   )
   UPDATE kg_nodes
      SET warned_at = NOW(),
          warn_reason = candidates.reason
     FROM candidates
    WHERE kg_nodes.id = candidates.id
   RETURNING candidates.id,
             candidates.type,
             candidates.label,
             candidates.confidence,
             candidates.sensitivity,
             candidates.edge_count,
             candidates.reason AS warn_reason,
             kg_nodes.warned_at`,
  [archiveThreshold, edgeCountThreshold],
);

const nodesWarned = warnResult.rowCount ?? 0;

// Emit a bus event for each warned node (audit trail + future subscriber hooks)
for (const row of warnResult.rows) {
  await this.bus.publish('system', createMemoryDecayWarning({
    nodeId: row.id,
    nodeType: row.type as import('../bus/events.js').MemoryDecayWarningPayload['nodeType'],
    label: row.label,
    confidence: row.confidence,
    sensitivity: row.sensitivity as import('../bus/events.js').MemoryDecayWarningPayload['sensitivity'],
    edgeCount: parseInt(row.edge_count, 10),
    reason: row.warn_reason as 'high_sensitivity' | 'high_connectivity' | 'both',
  }));
}
```

- [ ] **Step 4: Implement the modified archive passes**

Replace the existing Pass 2 with Pass 2a and Pass 2b:

```typescript
// Pass 2a: Archive expired warnings — nodes whose hold-back window has closed
// without a CEO response. These were warned but never confirmed or dismissed.
const archiveExpiredResult = await client.query(
  `UPDATE kg_nodes
      SET archived_at = NOW(),
          warned_at = NULL,
          warn_reason = NULL
    WHERE archived_at IS NULL
      AND warned_at IS NOT NULL
      AND warned_at <= NOW() - ($1 || ' days')::INTERVAL`,
  [this.config.warnHoldBackDays],
);
const nodesExpired = archiveExpiredResult.rowCount ?? 0;

// Pass 2b: Archive regular nodes at or below threshold. Excludes:
// - permanent nodes (never archived by design)
// - nodes with an active warning still within the hold-back window (warned_at IS NOT NULL)
//   Note: expired warnings were already archived in Pass 2a and now have
//   archived_at set, so the `archived_at IS NULL` guard above already excludes them.
const archiveNodeResult = await client.query(
  `UPDATE kg_nodes
      SET archived_at = NOW()
    WHERE archived_at IS NULL
      AND decay_class != 'permanent'
      AND confidence <= $1
      AND warned_at IS NULL`,
  [archiveThreshold],
);
const nodesArchived = archiveNodeResult.rowCount ?? 0;
```

Update the return statement to include the new fields:
```typescript
return { nodesDecayed, edgesDecayed, nodesWarned, nodesExpired, nodesArchived, edgesArchived };
```

Also update `runDecayPass` to log the new fields:
```typescript
this.logger.info(
  { ...result, durationMs },
  'DreamEngine: decay pass complete',
);
```

(No change needed — spread already picks up the new fields.)

- [ ] **Step 5: Run the tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning test src/memory/dream-engine.test.ts 2>&1 | tail -40
```

Expected: all tests pass, including the new `DreamEngine warn pass` describe block.

- [ ] **Step 6: Fix the existing test that checks the total number of queries**

The existing test `'runs all three passes and returns counts'` (line 53) expects `queries.length` to be 8 (BEGIN + 6 data queries + COMMIT). The warn pass adds 2 more data queries (threshold + warn UPDATE) and the archive pass splits into 2, so the new total is 11 (BEGIN + 9 data queries + COMMIT). Update the test:

```typescript
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
```

Keep `makePool` — the `DreamEngine with AutonomyScoringPass` tests at the bottom of the file still use it. Only update the existing `'runs all three passes and returns counts'` test as shown above; leave all other existing tests that don't check query counts as-is.

Re-run the tests to confirm all pass:

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning test src/memory/dream-engine.test.ts 2>&1 | tail -30
```

- [ ] **Step 7: Check TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add src/memory/dream-engine.ts src/memory/dream-engine.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "feat: implement DreamEngine warn pass and modified archive passes (#280)"
```

---

## Task 6: `decay-warnings-list` skill

**Files:**
- Create: `skills/decay-warnings-list/skill.json`
- Create: `skills/decay-warnings-list/handler.ts`
- Create: `skills/decay-warnings-list/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `skills/decay-warnings-list/handler.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { SkillContext, SkillResult } from '../../src/skills/types.js';
import { DecayWarningsListHandler } from './handler.js';

function makeCtx(warnings: unknown[]): SkillContext {
  return {
    input: {},
    entityMemory: {
      listDecayWarnings: vi.fn().mockResolvedValue(warnings),
    },
    timezone: 'America/Toronto',
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as SkillContext;
}

const warnedAt = new Date('2026-05-10T14:00:00.000Z');  // 2 days before 2026-05-12

describe('DecayWarningsListHandler', () => {
  it('returns warned nodes sorted oldest-first with daysRemaining', async () => {
    const ctx = makeCtx([
      {
        nodeId: 'node-1', nodeType: 'person', label: 'Alice', confidence: 0.04,
        sensitivity: 'confidential', edgeCount: 3, reason: 'high_sensitivity',
        warnedAt,
      },
    ]);
    const handler = new DecayWarningsListHandler();
    const result: SkillResult = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { warnings: unknown[]; count: number } }).data;
    expect(data.count).toBe(1);
    expect(data.warnings).toHaveLength(1);
    const w = data.warnings[0] as {
      nodeId: string; daysRemaining: number; reason: string; sensitivity: string;
    };
    expect(w.nodeId).toBe('node-1');
    expect(w.reason).toBe('high_sensitivity');
    expect(w.daysRemaining).toBeGreaterThan(0);
    expect(w.daysRemaining).toBeLessThanOrEqual(7);
  });

  it('returns empty list when no warnings', async () => {
    const ctx = makeCtx([]);
    const handler = new DecayWarningsListHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { count: number } }).data;
    expect(data.count).toBe(0);
  });

  it('returns success: false when entityMemory is unavailable', async () => {
    const ctx = {
      input: {},
      entityMemory: undefined,
      log: { error: vi.fn() },
    } as unknown as SkillContext;
    const handler = new DecayWarningsListHandler();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning test skills/decay-warnings-list/handler.test.ts 2>&1 | tail -20
```

Expected: FAIL (handler.ts does not exist).

- [ ] **Step 3: Write the skill manifest**

Create `skills/decay-warnings-list/skill.json`:

```json
{
  "name": "decay-warnings-list",
  "description": "List knowledge graph nodes flagged for CEO re-confirmation before archival. Returns nodeId, label, nodeType, sensitivity, edgeCount, reason (high_sensitivity/high_connectivity/both), daysRemaining, and warnedAt per warning. Sorted oldest-first.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {},
  "outputs": {
    "warnings": "object[]",
    "count": "number"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000,
  "capabilities": ["entityMemory"]
}
```

- [ ] **Step 4: Write the handler**

Create `skills/decay-warnings-list/handler.ts`:

```typescript
// handler.ts — decay-warnings-list skill
//
// Returns KG nodes flagged by DreamEngine for CEO re-confirmation before archival.
// A node is warned if it's important (high sensitivity or high connectivity) and
// its confidence has dropped to the archive threshold. The CEO has 7 days to confirm
// or dismiss before the node is auto-archived.
//
// daysRemaining is computed from warned_at + 7 days - now(). The coordinator uses
// this to communicate urgency: "this will be archived in 3 days — is it still accurate?"

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

// Hold-back window in days — must match DreamEngine's warnHoldBackDays default.
// Skills don't have access to DreamEngine config, so this is a shared constant.
// If the DreamEngine config is changed, update this value to match.
const WARN_HOLD_BACK_DAYS = 7;

export class DecayWarningsListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.entityMemory) {
      return { success: false, error: 'Entity memory service not available. Declare "entityMemory" in capabilities.' };
    }

    const tz = ctx.timezone;
    const now = Date.now();

    try {
      const warnings = await ctx.entityMemory.listDecayWarnings();

      const summaries = warnings.map(w => {
        const warnedAtMs = w.warnedAt.getTime();
        const expiresAtMs = warnedAtMs + WARN_HOLD_BACK_DAYS * 24 * 60 * 60 * 1000;
        const daysRemaining = Math.max(0, Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000)));
        return {
          nodeId: w.nodeId,
          nodeType: w.nodeType,
          label: w.label,
          confidence: Math.round(w.confidence * 1000) / 1000,
          sensitivity: w.sensitivity,
          edgeCount: w.edgeCount,
          reason: w.reason,
          warnedAt: tz ? toLocalIso(Math.floor(warnedAtMs / 1000), tz) : w.warnedAt.toISOString(),
          daysRemaining,
        };
      });

      ctx.log.info({ count: warnings.length }, 'decay-warnings-list: listed warnings');
      return {
        success: true,
        data: {
          warnings: summaries,
          count: summaries.length,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'decay-warnings-list: failed to list warnings');
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to list decay warnings: ${message}` };
    }
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning test skills/decay-warnings-list/handler.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Check TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run typecheck
```

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add skills/decay-warnings-list/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "feat: add decay-warnings-list skill (#280)"
```

---

## Task 7: `memory-confirm` skill

**Files:**
- Create: `skills/memory-confirm/skill.json`
- Create: `skills/memory-confirm/handler.ts`
- Create: `skills/memory-confirm/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `skills/memory-confirm/handler.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { SkillContext } from '../../src/skills/types.js';
import { MemoryConfirmHandler } from './handler.js';

function makeCtx(
  action: string,
  nodeId: string,
  confirmResult: { success: boolean; label?: string },
  dismissResult: { success: boolean; label?: string },
): SkillContext {
  return {
    input: { nodeId, action },
    entityMemory: {
      confirmDecayWarning: vi.fn().mockResolvedValue(confirmResult),
      dismissDecayWarning: vi.fn().mockResolvedValue(dismissResult),
    },
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as SkillContext;
}

describe('MemoryConfirmHandler', () => {
  it('confirm action resets the node and returns success', async () => {
    const ctx = makeCtx('confirm', 'node-1',
      { success: true, label: 'Alice' },
      { success: false },
    );
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { action: string; label: string; nodeId: string } }).data;
    expect(data.action).toBe('confirmed');
    expect(data.label).toBe('Alice');
    expect(data.nodeId).toBe('node-1');
    expect(ctx.entityMemory!.confirmDecayWarning).toHaveBeenCalledWith('node-1');
    expect(ctx.entityMemory!.dismissDecayWarning).not.toHaveBeenCalled();
  });

  it('dismiss action archives the node and returns success', async () => {
    const ctx = makeCtx('dismiss', 'node-2',
      { success: false },
      { success: true, label: 'Budget 2025' },
    );
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { action: string } }).data;
    expect(data.action).toBe('dismissed');
    expect(ctx.entityMemory!.dismissDecayWarning).toHaveBeenCalledWith('node-2');
    expect(ctx.entityMemory!.confirmDecayWarning).not.toHaveBeenCalled();
  });

  it('returns success: false when node is not in warned state', async () => {
    const ctx = makeCtx('confirm', 'node-3',
      { success: false },  // confirmDecayWarning returns false → node not warned
      { success: false },
    );
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
  });

  it('returns success: false for unknown action', async () => {
    const ctx = makeCtx('delete', 'node-1', { success: true, label: 'X' }, { success: true, label: 'X' });
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/invalid action/i);
  });

  it('returns success: false when entityMemory is unavailable', async () => {
    const ctx = {
      input: { nodeId: 'n', action: 'confirm' },
      entityMemory: undefined,
      log: { error: vi.fn() },
    } as unknown as SkillContext;
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning test skills/memory-confirm/handler.test.ts 2>&1 | tail -20
```

Expected: FAIL (handler.ts does not exist).

- [ ] **Step 3: Write the skill manifest**

Create `skills/memory-confirm/skill.json`:

```json
{
  "name": "memory-confirm",
  "description": "Confirm or dismiss a knowledge graph node flagged by the decay warning pass. Use 'confirm' when the CEO says a fact is still accurate (resets decay clock to full confidence). Use 'dismiss' when the CEO says it's no longer relevant (archives immediately). Returns success, the action taken, and the node label.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "nodeId": "string",
    "action": "string"
  },
  "outputs": {
    "success": "boolean",
    "action": "string",
    "nodeId": "string",
    "label": "string"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000,
  "capabilities": ["entityMemory"]
}
```

- [ ] **Step 4: Write the handler**

Create `skills/memory-confirm/handler.ts`:

```typescript
// handler.ts — memory-confirm skill
//
// Records the CEO's decision on a knowledge graph node flagged for re-confirmation.
//
// "confirm" — the CEO says the fact is still accurate. Resets last_confirmed_at = NOW()
// and confidence = 1.0, clears the warned_at flag. The node re-enters the normal
// decay cycle fresh, as if it was just confirmed today.
//
// "dismiss" — the CEO says the fact is no longer relevant. Archives immediately.
//
// Both operations are idempotent-safe: if the node is already archived or no longer
// in a warned state, the handler returns success: false rather than throwing.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class MemoryConfirmHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.entityMemory) {
      return { success: false, error: 'Entity memory service not available. Declare "entityMemory" in capabilities.' };
    }

    const { nodeId, action } = ctx.input as { nodeId: string; action: string };

    if (!nodeId || typeof nodeId !== 'string') {
      return { success: false, error: 'nodeId is required.' };
    }

    if (action !== 'confirm' && action !== 'dismiss') {
      return { success: false, error: `Invalid action "${action}". Must be "confirm" or "dismiss".` };
    }

    try {
      if (action === 'confirm') {
        const result = await ctx.entityMemory.confirmDecayWarning(nodeId);
        if (!result.success) {
          return { success: false, error: `Node ${nodeId} is not in a warned state (may already be archived or confirmed).` };
        }
        ctx.log.info({ nodeId, label: result.label }, 'memory-confirm: confirmed node');
        return { success: true, data: { action: 'confirmed', nodeId, label: result.label ?? '' } };
      } else {
        const result = await ctx.entityMemory.dismissDecayWarning(nodeId);
        if (!result.success) {
          return { success: false, error: `Node ${nodeId} is not in a warned state (may already be archived or dismissed).` };
        }
        ctx.log.info({ nodeId, label: result.label }, 'memory-confirm: dismissed node');
        return { success: true, data: { action: 'dismissed', nodeId, label: result.label ?? '' } };
      }
    } catch (err) {
      ctx.log.error({ err, nodeId, action }, 'memory-confirm: failed');
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to ${action} node: ${message}` };
    }
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning test skills/memory-confirm/handler.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Check TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run typecheck
```

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add skills/memory-confirm/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "feat: add memory-confirm skill (#280)"
```

---

## Task 8: Coordinator prompt + pinned skills

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Add the decay warning section to the coordinator prompt**

Find the `## Held Messages` section (around line 273). After the entire held-messages block (ending around line 301, just before `## Scheduled Tasks`), add:

```yaml
  ## Decay Warnings
  When KG nodes are flagged for re-confirmation by the memory decay engine:

  When talking to the CEO:
  - After checking held messages, call decay-warnings-list to check for
    knowledge graph nodes flagged for re-confirmation before archival.
  - If there are warnings, surface the oldest one (sorted by warnedAt) at
    a natural pause in conversation. Don't interrupt urgent topics.
  - Phrase the nudge concisely. Use the reason to tailor it:
    - high_sensitivity: "I have [label] on file but it's going stale — it's
      marked confidential. Is it still accurate?"
    - high_connectivity: "I have [label] on file but it's going stale — it's
      connected to [edgeCount] other facts in my notes. Is it still accurate?"
    - both: "I have [label] on file but it's going stale — it's confidential
      and well-connected. Is it still accurate?"
  - Tell the CEO how many days they have: "It'll be archived in [daysRemaining]
    days if I don't hear from you."
  - If the CEO confirms ("yes", "still true", "keep it"), call memory-confirm
    with action "confirm".
  - If the CEO dismisses ("no", "archive it", "doesn't matter", "not relevant"),
    call memory-confirm with action "dismiss".
  - Surface only ONE warning per conversation turn — don't list them all.
  - Use decay-warnings-list to show all pending warnings if the CEO asks
    ("show me what's going stale", "what needs my review").
```

- [ ] **Step 2: Add to `pinned_skills`**

Find the `pinned_skills` section (around line 491). Add the two new skills:

```yaml
  - decay-warnings-list
  - memory-confirm
```

(Add them after `held-messages-process` or grouped logically near memory-related skills like `memory-query` and `memory-store`.)

- [ ] **Step 3: Check the YAML is valid**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run typecheck
```

Also verify the app boots without error:
```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning run build 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "feat: wire coordinator to surface decay warnings to CEO (#280)"
```

---

## Task 9: Full test run + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning test 2>&1 | tail -30
```

Expected: all tests pass (no regressions).

- [ ] **Step 2: Update CHANGELOG.md**

Under `## [Unreleased]`, add:

```markdown
### Added
- **Decay warnings (#280):** DreamEngine now flags important KG nodes before archiving — high-sensitivity (`confidential`/`restricted`) or high-connectivity (top 5th percentile by edge count, floor 5) nodes get a 7-day hold-back window instead of silent archival. The coordinator proactively surfaces re-confirmation nudges to the CEO; confirming resets the decay clock, dismissing archives immediately.
- **`decay-warnings-list` skill:** Lists KG nodes currently in the warned state with `daysRemaining` until auto-archive.
- **`memory-confirm` skill:** Records the CEO's confirm or dismiss decision on a warned node.
- **`memory.decay_warning` bus event:** Emitted by DreamEngine for each newly warned node (audit trail).
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decay-warning commit -m "chore: update CHANGELOG for decay warning feature (#280)"
```
