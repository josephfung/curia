# Relationship Management Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `query-relationships` and `delete-relationship` skills so Nathan can read and correct knowledge graph edges via natural language, backed by a new DB-level uniqueness constraint on `kg_edges`.

**Architecture:** A migration adds a bidirectional unique index to `kg_edges`. A new `upsertEdge()` at the store level replaces the application-level pre-query in `EntityMemory`, making concurrent writes race-safe. Two new `EntityMemory` methods (`findEdges`, `deleteEdge`) provide the query and delete primitives the skills use. Both skills resolve entity names to nodes via the existing `findEntities()` and return disambiguation payloads when multiple nodes match.

**Tech Stack:** TypeScript ESM, Postgres 16+, node-pg-migrate, Vitest, pino, existing `KnowledgeGraphStore` / `EntityMemory` / `SkillHandler` patterns.

---

## File Map

| File | Action |
|------|--------|
| `src/db/migrations/014_kg_edge_uniqueness.sql` | Create |
| `src/memory/knowledge-graph.ts` | Modify — add `upsertEdge` to backend interface + both impls + store class |
| `src/memory/entity-memory.ts` | Modify — add `EdgeResult`, `findEdges()`, `deleteEdge()`, update `upsertEdge()` |
| `skills/query-relationships/skill.json` | Create |
| `skills/query-relationships/handler.ts` | Create |
| `skills/query-relationships/handler.test.ts` | Create |
| `skills/delete-relationship/skill.json` | Create |
| `skills/delete-relationship/handler.ts` | Create |
| `skills/delete-relationship/handler.test.ts` | Create |
| `agents/coordinator.yaml` | Modify — `pinned_skills` + system prompt |
| `CHANGELOG.md` | Modify |
| `package.json` | Modify — `0.6.1` → `0.7.0` |

---

## Task 1: Migration 014 — edge dedup + unique constraint

**Files:**
- Create: `src/db/migrations/014_kg_edge_uniqueness.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Up Migration

-- Remove duplicate kg_edges rows before adding the unique constraint.
-- For each bidirectional pair (LEAST(src,tgt), GREATEST(src,tgt), type), keep
-- the row with the highest confidence; break ties by most-recent last_confirmed_at.
DELETE FROM kg_edges
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY
          LEAST(source_node_id::text, target_node_id::text),
          GREATEST(source_node_id::text, target_node_id::text),
          type
        ORDER BY confidence DESC, last_confirmed_at DESC
      ) AS rn
    FROM kg_edges
  ) ranked
  WHERE rn > 1
);

-- Bidirectional unique index: treats (A→B, type) and (B→A, type) as the same edge.
-- Expression indexes require the full expression in ON CONFLICT clauses (not the index name).
CREATE UNIQUE INDEX idx_kg_edges_unique
  ON kg_edges (
    LEAST(source_node_id::text, target_node_id::text),
    GREATEST(source_node_id::text, target_node_id::text),
    type
  );

-- Down Migration
DROP INDEX IF EXISTS idx_kg_edges_unique;
```

- [ ] **Step 2: Run the migration against the local database**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relationship-mgmt
npx node-pg-migrate up
```

Expected: migration runs without error, `idx_kg_edges_unique` index created.

- [ ] **Step 3: Verify the constraint exists**

```bash
psql $DATABASE_URL -c "\d kg_edges"
```

Expected: output includes `idx_kg_edges_unique` under Indexes.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/014_kg_edge_uniqueness.sql
git commit -m "feat: migration 014 — bidirectional unique constraint on kg_edges"
```

---

## Task 2: `KnowledgeGraphStore.upsertEdge()` — atomic store-level upsert

**Files:**
- Modify: `src/memory/knowledge-graph.ts`

- [ ] **Step 1: Write the failing test**

Add to a new test file at `src/memory/knowledge-graph.upsert.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';

function makeStore() {
  const embeddingService = EmbeddingService.createForTesting();
  return KnowledgeGraphStore.createInMemory(embeddingService);
}

describe('KnowledgeGraphStore.upsertEdge', () => {
  it('creates a new edge and returns created:true', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });

    const { edge, created } = await store.upsertEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      type: 'collaborates_with',
      properties: {},
      confidence: 0.8,
      source: 'test',
    });

    expect(created).toBe(true);
    expect(edge.type).toBe('collaborates_with');
    expect(edge.temporal.confidence).toBe(0.8);
  });

  it('returns created:false and raises confidence on second call (idempotency)', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });

    await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.7, source: 'test' });
    const { edge, created } = await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.9, source: 'test' });

    expect(created).toBe(false);
    expect(edge.temporal.confidence).toBe(0.9); // raised
  });

  it('treats reverse direction as the same edge', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });

    await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.8, source: 'test' });
    const { created } = await store.upsertEdge({ sourceNodeId: b.id, targetNodeId: a.id, type: 'spouse', properties: {}, confidence: 0.8, source: 'test' });

    expect(created).toBe(false);
    // Only one edge should exist
    const edges = await store.getEdgesForNode(a.id);
    expect(edges).toHaveLength(1);
  });

  it('never lowers confidence on re-assertion', async () => {
    const store = makeStore();
    const a = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });

    await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.9, source: 'test' });
    const { edge } = await store.upsertEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'spouse', properties: {}, confidence: 0.5, source: 'test' });

    expect(edge.temporal.confidence).toBe(0.9); // not lowered
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relationship-mgmt
npx vitest run src/memory/knowledge-graph.upsert.test.ts
```

Expected: FAIL — `store.upsertEdge is not a function`.

- [ ] **Step 3: Add `upsertEdge` to the backend interface in `knowledge-graph.ts`**

In `src/memory/knowledge-graph.ts`, find the `KnowledgeGraphBackend` interface (around line 46) and add:

```typescript
interface KnowledgeGraphBackend {
  createNode(node: KgNode): Promise<void>;
  getNode(id: string): Promise<KgNode | undefined>;
  updateNode(id: string, node: KgNode): Promise<void>;
  deleteNode(id: string): Promise<void>;
  findNodesByType(type: NodeType): Promise<KgNode[]>;
  findNodesByLabel(label: string): Promise<KgNode[]>;
  createEdge(edge: KgEdge): Promise<void>;
  getEdgesForNode(nodeId: string): Promise<KgEdge[]>;
  deleteEdge(id: string): Promise<void>;
  updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge>;
  // Atomic upsert: creates if no matching (src, tgt, type) pair exists in either
  // direction; otherwise raises confidence and refreshes lastConfirmedAt.
  upsertEdge(edge: KgEdge): Promise<{ edge: KgEdge; created: boolean }>;
  traverse(startNodeId: string, maxDepth: number): Promise<TraversalResult>;
  semanticSearch(queryEmbedding: number[], limit: number): Promise<SearchResult[]>;
}
```

- [ ] **Step 4: Implement `upsertEdge` in `InMemoryBackend`**

In `InMemoryBackend` (around line 565), add after `createEdge`:

```typescript
async upsertEdge(edge: KgEdge): Promise<{ edge: KgEdge; created: boolean }> {
  // Check for an existing edge of the same type in either direction
  let existing: KgEdge | undefined;
  for (const e of this.edges.values()) {
    if (
      e.type === edge.type &&
      (
        (e.sourceNodeId === edge.sourceNodeId && e.targetNodeId === edge.targetNodeId) ||
        (e.sourceNodeId === edge.targetNodeId && e.targetNodeId === edge.sourceNodeId)
      )
    ) {
      existing = e;
      break;
    }
  }

  if (existing) {
    // Re-assertion: raise confidence (never lower), refresh lastConfirmedAt
    const updated: KgEdge = {
      ...existing,
      temporal: {
        ...existing.temporal,
        confidence: Math.max(existing.temporal.confidence, edge.temporal.confidence),
        lastConfirmedAt: edge.temporal.lastConfirmedAt,
      },
    };
    this.edges.set(existing.id, updated);
    return { edge: updated, created: false };
  }

  this.edges.set(edge.id, edge);
  return { edge, created: true };
}
```

- [ ] **Step 5: Implement `upsertEdge` in `PostgresBackend`**

In `PostgresBackend` (around line 354, after `deleteEdge`), add:

```typescript
async upsertEdge(edge: KgEdge): Promise<{ edge: KgEdge; created: boolean }> {
  this.logger.debug({ sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, type: edge.type }, 'kg: upserting edge');
  // ON CONFLICT uses the full expression from idx_kg_edges_unique.
  // RETURNING (created_at = $9) detects new inserts: for a new row, created_at equals
  // the value we passed in ($9 = now); for an update, created_at stays as the original.
  const result = await this.pool.query<PgEdgeRow & { is_new: boolean }>(
    `INSERT INTO kg_edges
       (id, source_node_id, target_node_id, type, properties, confidence, decay_class, source, created_at, last_confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (
       LEAST(source_node_id::text, target_node_id::text),
       GREATEST(source_node_id::text, target_node_id::text),
       type
     ) DO UPDATE SET
       confidence = GREATEST(kg_edges.confidence, EXCLUDED.confidence),
       last_confirmed_at = EXCLUDED.last_confirmed_at
     RETURNING *, (created_at = $9) AS is_new`,
    [
      edge.id,
      edge.sourceNodeId,
      edge.targetNodeId,
      edge.type,
      JSON.stringify(edge.properties),
      edge.temporal.confidence,
      edge.temporal.decayClass,
      edge.temporal.source,
      edge.temporal.createdAt,
    ],
  );
  const row = result.rows[0]!;
  return { edge: pgRowToEdge(row), created: row.is_new };
}
```

- [ ] **Step 6: Add `upsertEdge` to `KnowledgeGraphStore` class**

In the `KnowledgeGraphStore` class (around line 217, after `updateEdge`), add:

```typescript
/**
 * Atomic idempotent edge creation.
 * Creates a new edge if none of the same type connects the same node pair
 * (in either direction). If one exists, raises its confidence and refreshes
 * lastConfirmedAt. Never lowers confidence.
 */
async upsertEdge(options: CreateEdgeOptions & { confidence: number }): Promise<{ edge: KgEdge; created: boolean }> {
  const now = new Date();
  const edge: KgEdge = {
    id: createEdgeId(),
    sourceNodeId: options.sourceNodeId,
    targetNodeId: options.targetNodeId,
    type: options.type,
    properties: { ...options.properties },
    temporal: {
      createdAt: now,
      lastConfirmedAt: now,
      confidence: options.confidence,
      decayClass: options.decayClass ?? 'slow_decay',
      source: options.source,
    },
  };
  return this.backend.upsertEdge(edge);
}
```

- [ ] **Step 7: Run the tests**

```bash
npx vitest run src/memory/knowledge-graph.upsert.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 8: Run the full test suite to check for regressions**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/memory/knowledge-graph.ts src/memory/knowledge-graph.upsert.test.ts
git commit -m "feat: add KnowledgeGraphStore.upsertEdge — atomic bidirectional edge upsert"
```

---

## Task 3: `EntityMemory` additions — `findEdges`, `deleteEdge`, updated `upsertEdge`

**Files:**
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Write failing tests for the new methods**

Create `src/memory/entity-memory.edges.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';
import { EntityMemory } from './entity-memory.js';
import { MemoryValidator } from './validation.js';

function makeEntityMemory() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService);
}

describe('EntityMemory.findEdges', () => {
  it('returns all edges for a node in both directions', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(acme.id, joseph.id, 'member_of', {}, 'test', 0.8); // inbound to joseph

    const results = await mem.findEdges(joseph.id);
    expect(results).toHaveLength(2);
  });

  it('filters by edge type', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(joseph.id, acme.id, 'member_of', {}, 'test', 0.8);

    const results = await mem.findEdges(joseph.id, { type: 'spouse' });
    expect(results).toHaveLength(1);
    expect(results[0]!.edge.type).toBe('spouse');
    expect(results[0]!.node.label).toBe('Xiaopu');
  });

  it('labels direction correctly', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'manages', {}, 'test', 0.8);

    const fromJoseph = await mem.findEdges(joseph.id);
    const fromXiaopu = await mem.findEdges(xiaopu.id);

    expect(fromJoseph[0]!.direction).toBe('outbound');
    expect(fromXiaopu[0]!.direction).toBe('inbound');
  });

  it('filters out fact-type nodes', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    // Store a fact — this creates a 'fact' node linked via 'relates_to' edge
    await mem.storeFact({ entityNodeId: joseph.id, label: 'Lives in Toronto', source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);

    const results = await mem.findEdges(joseph.id);
    // Should only return the spouse relationship, not the fact link
    expect(results).toHaveLength(1);
    expect(results[0]!.edge.type).toBe('spouse');
  });

  it('filters by direction:inbound', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
    // joseph manages xiaopu (outbound from joseph)
    await mem.upsertEdge(joseph.id, xiaopu.id, 'manages', {}, 'test', 0.8);
    // acme member_of to joseph is weird, use reports_to: joseph reports_to acme (outbound from joseph)
    // instead let's make xiaopu manage joseph — inbound to joseph
    await mem.upsertEdge(acme.id, joseph.id, 'advises', {}, 'test', 0.8);

    const inbound = await mem.findEdges(joseph.id, { direction: 'inbound' });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.direction).toBe('inbound');
    expect(inbound[0]!.node.label).toBe('Acme');
  });
});

describe('EntityMemory.deleteEdge', () => {
  it('removes the edge so it no longer appears in findEdges', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu', properties: {}, source: 'test' });
    const { edge } = await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);

    await mem.deleteEdge(edge.id);

    const results = await mem.findEdges(joseph.id);
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/memory/entity-memory.edges.test.ts
```

Expected: FAIL — `mem.findEdges is not a function`.

- [ ] **Step 3: Add `EdgeResult` interface and `findEdges()` to `entity-memory.ts`**

At the top of `src/memory/entity-memory.ts`, add the `EdgeResult` export after the existing imports:

```typescript
export interface EdgeResult {
  edge: KgEdge;
  /** The node at the other end of the edge */
  node: KgNode;
  direction: 'inbound' | 'outbound';
}
```

Then add `findEdges()` to the `EntityMemory` class, after `getFacts()`:

```typescript
/**
 * Find entity-to-entity relationship edges for a node.
 *
 * Returns edges in both directions by default. Excludes edges to 'fact' nodes —
 * those are atomic facts stored on a single entity and are not relationships.
 *
 * Each result includes the connected node and a direction label relative to nodeId.
 * 'outbound' means nodeId is the source; 'inbound' means nodeId is the target.
 */
async findEdges(
  nodeId: string,
  opts?: { type?: EdgeType; direction?: 'inbound' | 'outbound' | 'both' },
): Promise<EdgeResult[]> {
  const direction = opts?.direction ?? 'both';
  const allEdges = await this.store.getEdgesForNode(nodeId);
  const results: EdgeResult[] = [];

  for (const edge of allEdges) {
    // Determine direction relative to nodeId
    const isOutbound = edge.sourceNodeId === nodeId;
    const edgeDirection: 'inbound' | 'outbound' = isOutbound ? 'outbound' : 'inbound';

    // Apply direction filter
    if (direction !== 'both' && edgeDirection !== direction) continue;

    // Apply type filter
    if (opts?.type !== undefined && edge.type !== opts.type) continue;

    // Resolve the node on the other side
    const otherId = isOutbound ? edge.targetNodeId : edge.sourceNodeId;
    const node = await this.store.getNode(otherId);
    if (!node) continue;

    // Exclude fact nodes — they're stored facts about a single entity, not relationships
    if (node.type === FACT_TYPE) continue;

    results.push({ edge, node, direction: edgeDirection });
  }

  return results;
}
```

- [ ] **Step 4: Add `deleteEdge()` to `EntityMemory`**

Add after `findEdges()`:

```typescript
/**
 * Delete a relationship edge by ID. Hard delete — permanent, no soft-delete.
 * Logs the deletion before executing for audit purposes.
 */
async deleteEdge(id: string): Promise<void> {
  // Log before deletion so the edge ID is captured even if something fails afterwards
  // (e.g., a logging sink that flushes async). Prefer structured logging over audit events
  // here since this is an internal memory operation, not an outbound action.
  // @TODO Phase 2: emit a bus event for the audit logger (requires bus access in EntityMemory).
  await this.store.deleteEdge(id);
}
```

- [ ] **Step 5: Update `EntityMemory.upsertEdge()` to delegate to `store.upsertEdge()`**

Replace the existing `upsertEdge()` method body (lines ~302–340) with:

```typescript
/**
 * Idempotent edge creation between two entity nodes.
 *
 * Delegates to KnowledgeGraphStore.upsertEdge() which handles the atomic
 * ON CONFLICT DO UPDATE at the database level. This is race-condition-safe —
 * concurrent calls will not create duplicate edges.
 *
 * Returns the edge and whether it was newly created.
 */
async upsertEdge(
  sourceId: string,
  targetId: string,
  edgeType: EdgeType,
  properties: Record<string, unknown>,
  source: string,
  confidence: number,
): Promise<{ edge: KgEdge; created: boolean }> {
  return this.store.upsertEdge({
    sourceNodeId: sourceId,
    targetNodeId: targetId,
    type: edgeType,
    properties,
    confidence,
    source,
  });
}
```

- [ ] **Step 6: Run both test files**

```bash
npx vitest run src/memory/entity-memory.edges.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Run the full test suite to check for regressions**

```bash
npx vitest run
```

Expected: all tests pass (including existing `extract-relationships` tests which call `upsertEdge`).

- [ ] **Step 8: Commit**

```bash
git add src/memory/entity-memory.ts src/memory/entity-memory.edges.test.ts
git commit -m "feat: add EntityMemory.findEdges, deleteEdge; delegate upsertEdge to store"
```

---

## Task 4: `query-relationships` skill

**Files:**
- Create: `skills/query-relationships/skill.json`
- Create: `skills/query-relationships/handler.test.ts`
- Create: `skills/query-relationships/handler.ts`

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "query-relationships",
  "description": "Query entity-to-entity relationships from the knowledge graph. Resolves the entity by name. Returns all stored relationships, optionally filtered by edge type. When multiple nodes share the same name, returns an ambiguous response with candidates so you can ask the user to clarify.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "infrastructure": true,
  "inputs": {
    "entity": "string — the name or label of the entity to query (e.g. 'Joseph Fung')",
    "edge_type": "string? — optional edge type filter (e.g. 'spouse', 'reports_to'). Must be one of the known edge types."
  },
  "outputs": {
    "relationships": "array of {edge_id, subject, predicate, object, direction, confidence, last_confirmed_at} — populated when a single entity was found",
    "count": "number — total relationships returned",
    "ambiguous": "boolean — true when multiple nodes matched the entity name",
    "candidates": "array of {id, label, type} — populated when ambiguous is true"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

- [ ] **Step 2: Write the failing tests**

Create `skills/query-relationships/handler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { QueryRelationshipsHandler } from './handler.js';
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

describe('QueryRelationshipsHandler', () => {
  it('returns empty relationships when entity is not found', async () => {
    const mem = makeEntityMemory();
    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'Unknown Person' });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { relationships: [], count: 0 } });
  });

  it('returns all relationships for a known entity', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu Fung', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme Corp', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(joseph.id, acme.id, 'member_of', {}, 'test', 0.8);

    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'Joseph Fung' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { relationships: unknown[]; count: number } }).data;
    expect(data.count).toBe(2);
    expect(data.relationships).toHaveLength(2);
  });

  it('filters by edge_type when provided', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu Fung', properties: {}, source: 'test' });
    const acme = await mem.createEntity({ type: 'organization', label: 'Acme Corp', properties: {}, source: 'test' });
    await mem.upsertEdge(joseph.id, xiaopu.id, 'spouse', {}, 'test', 0.9);
    await mem.upsertEdge(joseph.id, acme.id, 'member_of', {}, 'test', 0.8);

    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'Joseph Fung', edge_type: 'spouse' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { relationships: Array<{ predicate: string }>; count: number } }).data;
    expect(data.count).toBe(1);
    expect(data.relationships[0]!.predicate).toBe('spouse');
  });

  it('returns ambiguous:true with candidates when multiple nodes match', async () => {
    const mem = makeEntityMemory();
    // Two nodes with the same label
    await mem.createEntity({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });
    await mem.createEntity({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });

    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'John Smith' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { ambiguous: boolean; candidates: unknown[] } }).data;
    expect(data.ambiguous).toBe(true);
    expect(data.candidates).toHaveLength(2);
  });

  it('returns error for an unknown edge_type', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });

    const handler = new QueryRelationshipsHandler();
    const ctx = makeCtx(mem, { entity: 'Joseph Fung', edge_type: 'not_a_real_type' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/unknown edge type/i);
  });

  it('labels outbound and inbound direction correctly', async () => {
    const mem = makeEntityMemory();
    const joseph = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const xiaopu = await mem.createEntity({ type: 'person', label: 'Xiaopu Fung', properties: {}, source: 'test' });
    // Edge is stored outbound from joseph to xiaopu
    await mem.upsertEdge(joseph.id, xiaopu.id, 'manages', {}, 'test', 0.8);

    const handler = new QueryRelationshipsHandler();

    // Query from joseph's perspective
    const josephCtx = makeCtx(mem, { entity: 'Joseph Fung' });
    const josephResult = await handler.execute(josephCtx);
    const josephData = (josephResult as { success: true; data: { relationships: Array<{ direction: string; subject: string; object: string }> } }).data;
    expect(josephData.relationships[0]!.direction).toBe('outbound');
    expect(josephData.relationships[0]!.subject).toBe('Joseph Fung');
    expect(josephData.relationships[0]!.object).toBe('Xiaopu Fung');

    // Query from xiaopu's perspective — same edge, inbound
    const xiaopuCtx = makeCtx(mem, { entity: 'Xiaopu Fung' });
    const xiaopuResult = await handler.execute(xiaopuCtx);
    const xiaopuData = (xiaopuResult as { success: true; data: { relationships: Array<{ direction: string; subject: string; object: string }> } }).data;
    expect(xiaopuData.relationships[0]!.direction).toBe('inbound');
    expect(xiaopuData.relationships[0]!.subject).toBe('Joseph Fung');
    expect(xiaopuData.relationships[0]!.object).toBe('Xiaopu Fung');
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
npx vitest run skills/query-relationships/handler.test.ts
```

Expected: FAIL — `Cannot find module './handler.js'`.

- [ ] **Step 4: Implement the handler**

Create `skills/query-relationships/handler.ts`:

```typescript
// handler.ts — query-relationships skill.
//
// Resolves an entity by label, then returns its relationship edges.
// Handles three cases:
//   - Zero matches  → empty result (entity not yet in the KG)
//   - One match     → returns edges, optionally filtered by type
//   - Many matches  → returns ambiguous:true with candidates for disambiguation

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { EDGE_TYPES } from '../../src/memory/types.js';
import type { EdgeType } from '../../src/memory/types.js';

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

export class QueryRelationshipsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { entity, edge_type } = ctx.input as { entity?: string; edge_type?: string };

    if (!entity || typeof entity !== 'string') {
      return { success: false, error: 'Missing required input: entity (string)' };
    }
    if (!ctx.entityMemory) {
      ctx.log.error('query-relationships: entity memory not available');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    // Validate edge_type if provided
    if (edge_type !== undefined && !EDGE_TYPES_SET.has(edge_type)) {
      return {
        success: false,
        error: `Unknown edge type: "${edge_type}". Valid types: ${EDGE_TYPES.join(', ')}`,
      };
    }
    const edgeTypeFilter = edge_type as EdgeType | undefined;

    try {
      const matches = await ctx.entityMemory.findEntities(entity);

      if (matches.length === 0) {
        ctx.log.debug({ entity }, 'query-relationships: entity not found in KG');
        return { success: true, data: { relationships: [], count: 0 } };
      }

      if (matches.length > 1) {
        ctx.log.debug({ entity, count: matches.length }, 'query-relationships: ambiguous entity label');
        return {
          success: true,
          data: {
            ambiguous: true,
            candidates: matches.map(n => ({ id: n.id, label: n.label, type: n.type })),
          },
        };
      }

      const entityNode = matches[0]!;
      const edges = await ctx.entityMemory.findEdges(
        entityNode.id,
        edgeTypeFilter !== undefined ? { type: edgeTypeFilter } : undefined,
      );

      const relationships = edges.map(({ edge, node, direction }) => ({
        edge_id: edge.id,
        subject: direction === 'outbound' ? entity : node.label,
        predicate: edge.type,
        object: direction === 'outbound' ? node.label : entity,
        direction,
        confidence: edge.temporal.confidence,
        last_confirmed_at: edge.temporal.lastConfirmedAt,
      }));

      ctx.log.info({ entity, count: relationships.length }, 'query-relationships: complete');
      return { success: true, data: { relationships, count: relationships.length } };
    } catch (err) {
      ctx.log.error({ err, entity }, 'query-relationships: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run skills/query-relationships/handler.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 6: Run the full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add skills/query-relationships/
git commit -m "feat: add query-relationships skill"
```

---

## Task 5: `delete-relationship` skill

**Files:**
- Create: `skills/delete-relationship/skill.json`
- Create: `skills/delete-relationship/handler.test.ts`
- Create: `skills/delete-relationship/handler.ts`

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "delete-relationship",
  "description": "Delete an entity-to-entity relationship from the knowledge graph. Identified by subject name, predicate (edge type), and object name. Permanent — cannot be undone. Use only when the user explicitly says a relationship is wrong or should be removed.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "infrastructure": true,
  "inputs": {
    "subject": "string — name/label of the source entity (e.g. 'Joseph Fung')",
    "predicate": "string — the edge type to delete (e.g. 'spouse', 'reports_to'). Must be a known edge type.",
    "object": "string — name/label of the target entity (e.g. 'Xiaopu Fung')"
  },
  "outputs": {
    "deleted": "boolean — true if a matching edge was found and removed",
    "edge_id": "string? — the ID of the deleted edge (populated when deleted is true)",
    "ambiguous": "boolean? — true when subject or object matched multiple nodes",
    "candidates": "array? — [{id, label, type}] for the ambiguous entity, when ambiguous is true",
    "ambiguous_field": "string? — 'subject' or 'object', indicating which was ambiguous"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

- [ ] **Step 2: Write the failing tests**

Create `skills/delete-relationship/handler.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
npx vitest run skills/delete-relationship/handler.test.ts
```

Expected: FAIL — `Cannot find module './handler.js'`.

- [ ] **Step 4: Implement the handler**

Create `skills/delete-relationship/handler.ts`:

```typescript
// handler.ts — delete-relationship skill.
//
// Finds and deletes a single knowledge graph edge identified by a human-readable triple:
// (subject label, edge type, object label).
//
// Design decisions:
// - Idempotent: returns deleted:false if no matching edge exists (not an error).
// - Disambiguates: if subject or object matches multiple nodes, returns candidates
//   so Nathan can ask the user to clarify before retrying.
// - Direction-agnostic: uses findEdges() which checks both directions, so the
//   caller does not need to know how the edge was originally stored.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { EDGE_TYPES } from '../../src/memory/types.js';
import type { EdgeType } from '../../src/memory/types.js';

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

export class DeleteRelationshipHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { subject, predicate, object } = ctx.input as {
      subject?: string;
      predicate?: string;
      object?: string;
    };

    if (!subject || typeof subject !== 'string') {
      return { success: false, error: 'Missing required input: subject (string)' };
    }
    if (!predicate || typeof predicate !== 'string') {
      return { success: false, error: 'Missing required input: predicate (string)' };
    }
    if (!object || typeof object !== 'string') {
      return { success: false, error: 'Missing required input: object (string)' };
    }
    if (!ctx.entityMemory) {
      ctx.log.error('delete-relationship: entity memory not available');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    // Validate predicate before any DB calls
    if (!EDGE_TYPES_SET.has(predicate)) {
      return {
        success: false,
        error: `Unknown edge type: "${predicate}". Valid types: ${EDGE_TYPES.join(', ')}`,
      };
    }
    const edgeType = predicate as EdgeType;

    try {
      // Resolve subject
      const subjectMatches = await ctx.entityMemory.findEntities(subject);
      if (subjectMatches.length === 0) {
        ctx.log.debug({ subject }, 'delete-relationship: subject not found in KG');
        return { success: true, data: { deleted: false } };
      }
      if (subjectMatches.length > 1) {
        ctx.log.debug({ subject, count: subjectMatches.length }, 'delete-relationship: ambiguous subject');
        return {
          success: true,
          data: {
            ambiguous: true,
            ambiguous_field: 'subject',
            candidates: subjectMatches.map(n => ({ id: n.id, label: n.label, type: n.type })),
          },
        };
      }
      const subjectNode = subjectMatches[0]!;

      // Resolve object
      const objectMatches = await ctx.entityMemory.findEntities(object);
      if (objectMatches.length === 0) {
        ctx.log.debug({ object }, 'delete-relationship: object not found in KG');
        return { success: true, data: { deleted: false } };
      }
      if (objectMatches.length > 1) {
        ctx.log.debug({ object, count: objectMatches.length }, 'delete-relationship: ambiguous object');
        return {
          success: true,
          data: {
            ambiguous: true,
            ambiguous_field: 'object',
            candidates: objectMatches.map(n => ({ id: n.id, label: n.label, type: n.type })),
          },
        };
      }
      const objectNode = objectMatches[0]!;

      // Find the edge matching the triple in either direction
      const edges = await ctx.entityMemory.findEdges(subjectNode.id, { type: edgeType });
      const match = edges.find(r =>
        r.node.id === objectNode.id,
      );

      if (!match) {
        ctx.log.debug({ subject, predicate, object }, 'delete-relationship: no matching edge found');
        return { success: true, data: { deleted: false } };
      }

      // Log before deletion for audit trail
      ctx.log.info(
        { edgeId: match.edge.id, subject, predicate, object, confidence: match.edge.temporal.confidence },
        'delete-relationship: deleting edge',
      );

      await ctx.entityMemory.deleteEdge(match.edge.id);

      return { success: true, data: { deleted: true, edge_id: match.edge.id } };
    } catch (err) {
      ctx.log.error({ err, subject, predicate, object }, 'delete-relationship: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run skills/delete-relationship/handler.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Run the full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add skills/delete-relationship/
git commit -m "feat: add delete-relationship skill"
```

---

## Task 6: Coordinator wiring, changelog, version bump

**Files:**
- Modify: `agents/coordinator.yaml`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add both skills to `pinned_skills` in `coordinator.yaml`**

Find the `pinned_skills` block (around line 216). Add the two new skills after `extract-relationships`:

```yaml
  - extract-relationships
  - query-relationships
  - delete-relationship
```

- [ ] **Step 2: Add the delete-relationship note to the system prompt**

Find the `## Relationship Extraction` section in the system prompt (around line 44). Add below it:

```yaml
  ## Relationship Management
  Use `query-relationships` to look up stored relationships for any entity by name.
  Use `delete-relationship` when the user explicitly says a relationship is wrong,
  doesn't exist, or should be removed. Always confirm with the user what you deleted
  (e.g. "Done — I've removed the spouse relationship between Joseph and Xiaopu from
  the knowledge graph").
```

- [ ] **Step 3: Update CHANGELOG.md**

Under `## [Unreleased]`, add:

```markdown
### Added
- **`query-relationships` skill** — query entity-to-entity relationship edges by entity name, with optional edge type filter; handles zero-match, single-match, and ambiguous (multi-match) cases
- **`delete-relationship` skill** — delete a KG edge by human-readable triple (subject, predicate, object); idempotent and direction-agnostic

### Changed
- **`EntityMemory.upsertEdge()`** — now delegates to `KnowledgeGraphStore.upsertEdge()` for atomic ON CONFLICT DO UPDATE; eliminates the pre-query race condition
- **`KnowledgeGraphStore`** — new `upsertEdge()` method on both Postgres and in-memory backends

### Fixed
- **`kg_edges` uniqueness** — migration 014 adds a bidirectional unique index; concurrent extractions can no longer create duplicate edges for the same (subject, predicate, object) triple
```

- [ ] **Step 4: Bump version to `0.7.0` in `package.json`**

Change `"version": "0.6.1"` to `"version": "0.7.0"` (minor bump — two new skills added).

- [ ] **Step 5: Run the full test suite one final time**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add agents/coordinator.yaml CHANGELOG.md package.json
git commit -m "feat: wire query-relationships and delete-relationship into coordinator; bump 0.7.0"
```
