# KG Node Deduplication and Uniqueness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate existing `kg_nodes` rows, enforce a `(lower(label), type)` unique constraint, and make all node-creation and node-update paths race-safe via upsert and merge-on-collision logic.

**Architecture:** Three layers of change: (1) a one-time SQL migration that cleans up existing duplicates and adds the unique index; (2) a new `upsertNode` method on `KnowledgeGraphStore` that uses `INSERT ... ON CONFLICT DO UPDATE`; (3) `EntityMemory` updates — a public `updateNode` that detects label collisions and merges nodes, a changed `createEntity` return type, and completing `mergeEntities` Phase 2 (edge re-pointing + secondary deletion).

**Tech Stack:** TypeScript/ESM, Vitest, PostgreSQL 16+/pgvector, node-postgres

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/memory/knowledge-graph.ts` | Modify | Add `upsertNode` to backend interface, `PostgresBackend`, `InMemoryBackend`, and `KnowledgeGraphStore` |
| `src/memory/knowledge-graph.upsert.test.ts` | Modify | Add `upsertNode` tests alongside existing `upsertEdge` tests |
| `src/memory/entity-memory.ts` | Modify | Complete `mergeEntities` Phase 2; add public `updateNode` with merge-on-collision; change `createEntity` return type |
| `src/memory/entity-memory.upsert.test.ts` | Create | Tests for `mergeEntities` Phase 2, `updateNode`, and `createEntity` new return type |
| `src/memory/entity-memory.edges.test.ts` | Modify | Update all `createEntity` call sites to destructure `{ entity }` |
| `src/contacts/contact-service.ts` | Modify | Destructure `{ entity, created }` from `createEntity`; apply `role` on conflict |
| `skills/extract-relationships/handler.ts` | Modify | Destructure `{ entity }` from `createEntity` in two places |
| `skills/knowledge-meeting-links/handler.ts` | Modify | Destructure `{ entity }` from `createEntity` |
| `skills/_shared/template-base.ts` | Modify | Destructure `{ entity }` from `createEntity` |
| `skills/query-relationships/handler.test.ts` | Modify | Update `createEntity` calls; fix ambiguous-duplicate test to use `store.createNode` directly |
| `skills/delete-relationship/handler.test.ts` | Modify | Update `createEntity` calls to destructure |
| `src/db/migrations/016_kg_node_uniqueness.sql` | Create | One-time dedup pass + unique index |
| `CHANGELOG.md` | Modify | Add entry under `[Unreleased]` |
| `package.json` | Modify | Patch version bump to `0.12.2` |

---

## Task 1: `upsertNode` in KnowledgeGraphStore

**Files:**
- Modify: `src/memory/knowledge-graph.upsert.test.ts`
- Modify: `src/memory/knowledge-graph.ts`

- [ ] **Step 1: Write failing tests for `upsertNode`**

Append to `src/memory/knowledge-graph.upsert.test.ts` (after the existing `upsertEdge` describe block):

```ts
describe('KnowledgeGraphStore.upsertNode', () => {
  it('creates a new node and returns created:true', async () => {
    const store = makeStore();

    const { node, created } = await store.upsertNode({
      type: 'person',
      label: 'Alice',
      properties: {},
      confidence: 0.8,
      source: 'test',
    });

    expect(created).toBe(true);
    expect(node.label).toBe('Alice');
    expect(node.temporal.confidence).toBe(0.8);
  });

  it('returns existing node with created:false on same (label, type)', async () => {
    const store = makeStore();

    const { node: first } = await store.upsertNode({ type: 'person', label: 'Alice', properties: {}, confidence: 0.8, source: 'test' });
    const { node: second, created } = await store.upsertNode({ type: 'person', label: 'ALICE', properties: { extra: true }, confidence: 0.9, source: 'test' });

    expect(created).toBe(false);
    expect(second.id).toBe(first.id);
    // Confidence raised
    expect(second.temporal.confidence).toBe(0.9);
    // Properties NOT overwritten on conflict
    expect(second.properties).not.toHaveProperty('extra');
  });

  it('never lowers confidence on re-assertion', async () => {
    const store = makeStore();

    await store.upsertNode({ type: 'person', label: 'Alice', properties: {}, confidence: 0.9, source: 'test' });
    const { node } = await store.upsertNode({ type: 'person', label: 'Alice', properties: {}, confidence: 0.5, source: 'test' });

    expect(node.temporal.confidence).toBe(0.9);
  });

  it('allows same label under different types', async () => {
    const store = makeStore();

    const { created: c1 } = await store.upsertNode({ type: 'person', label: 'Apple', properties: {}, confidence: 0.8, source: 'test' });
    const { created: c2 } = await store.upsertNode({ type: 'organization', label: 'Apple', properties: {}, confidence: 0.8, source: 'test' });

    expect(c1).toBe(true);
    expect(c2).toBe(true);
  });

  it('always creates fact nodes regardless of label collision', async () => {
    const store = makeStore();

    const { created: c1 } = await store.upsertNode({ type: 'fact', label: 'CEO', properties: {}, confidence: 0.8, source: 'test' });
    const { created: c2 } = await store.upsertNode({ type: 'fact', label: 'CEO', properties: {}, confidence: 0.8, source: 'test' });

    expect(c1).toBe(true);
    expect(c2).toBe(true); // fact nodes are always new inserts, not upserts
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test -- --reporter=verbose src/memory/knowledge-graph.upsert.test.ts
```

Expected: FAIL — `upsertNode is not a function`

- [ ] **Step 3: Add `upsertNode` to the backend interface**

In `src/memory/knowledge-graph.ts`, add to the `KnowledgeGraphBackend` interface (after `upsertEdge`):

```ts
upsertNode(node: KgNode): Promise<{ node: KgNode; created: boolean }>;
```

- [ ] **Step 4: Implement `upsertNode` in `InMemoryBackend`**

Add after `createNode` in `InMemoryBackend`:

```ts
async upsertNode(node: KgNode): Promise<{ node: KgNode; created: boolean }> {
  // fact nodes are never deduplicated — always insert as new
  if (node.type === 'fact') {
    this.nodes.set(node.id, node);
    return { node, created: true };
  }

  const lowerLabel = node.label.toLowerCase();
  let existing: KgNode | undefined;
  for (const n of this.nodes.values()) {
    if (n.type !== 'fact' && n.label.toLowerCase() === lowerLabel && n.type === node.type) {
      existing = n;
      break;
    }
  }

  if (existing) {
    const updated: KgNode = {
      ...existing,
      temporal: {
        ...existing.temporal,
        confidence: Math.max(existing.temporal.confidence, node.temporal.confidence),
        lastConfirmedAt: node.temporal.lastConfirmedAt,
      },
    };
    this.nodes.set(existing.id, updated);
    return { node: updated, created: false };
  }

  this.nodes.set(node.id, node);
  return { node, created: true };
}
```

- [ ] **Step 5: Implement `upsertNode` in `PostgresBackend`**

Add after `createNode` in `PostgresBackend`:

```ts
async upsertNode(node: KgNode): Promise<{ node: KgNode; created: boolean }> {
  this.logger.debug({ type: node.type, label: node.label }, 'kg: upserting node');
  const embeddingStr = node.embedding ? `[${node.embedding.join(',')}]` : null;
  const result = await this.pool.query<PgNodeRow & { is_new: boolean }>(
    `INSERT INTO kg_nodes (id, type, label, properties, embedding, confidence, decay_class, source, created_at, last_confirmed_at)
     VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $9)
     ON CONFLICT (lower(label), type) WHERE type != 'fact'
     DO UPDATE SET
       confidence = GREATEST(kg_nodes.confidence, EXCLUDED.confidence),
       last_confirmed_at = EXCLUDED.last_confirmed_at
     RETURNING *, (created_at = $9) AS is_new`,
    [
      node.id,
      node.type,
      node.label,
      JSON.stringify(node.properties),
      embeddingStr,
      node.temporal.confidence,
      node.temporal.decayClass,
      node.temporal.source,
      node.temporal.createdAt,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    this.logger.error(
      { type: node.type, label: node.label },
      'kg: upsertNode — RETURNING produced no row; possible trigger or RLS suppression',
    );
    throw new Error('upsertNode: database returned no row after INSERT ... ON CONFLICT');
  }
  return { node: pgRowToNode(row), created: row.is_new };
}
```

- [ ] **Step 6: Add `upsertNode` public method to `KnowledgeGraphStore`**

Add after `createNode` in `KnowledgeGraphStore`:

```ts
/**
 * Idempotent node creation for non-fact entity nodes.
 *
 * Creates a new node if none with the same (lower(label), type) exists.
 * If one exists, raises its confidence (never lowers) and refreshes
 * lastConfirmedAt. Properties, label, and embedding of the existing node
 * are left untouched — use updateNode() to change those explicitly.
 *
 * fact nodes always create a new node regardless of label collision.
 *
 * Returns the persisted node and whether it was newly created.
 */
async upsertNode(options: CreateNodeOptions & { confidence: number }): Promise<{ node: KgNode; created: boolean }> {
  const now = new Date();
  const embedding = options.embedding ?? await this.embeddingService.embed(options.label);

  const node: KgNode = {
    id: createNodeId(),
    type: options.type,
    label: options.label,
    properties: { ...options.properties },
    embedding,
    temporal: {
      createdAt: now,
      lastConfirmedAt: now,
      confidence: options.confidence,
      decayClass: options.decayClass ?? 'slow_decay',
      source: options.source,
    },
  };

  return this.backend.upsertNode(node);
}
```

- [ ] **Step 7: Run tests to confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test -- --reporter=verbose src/memory/knowledge-graph.upsert.test.ts
```

Expected: All `upsertNode` tests PASS. All existing `upsertEdge` tests still PASS.

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness add src/memory/knowledge-graph.ts src/memory/knowledge-graph.upsert.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness commit -m "feat: add KnowledgeGraphStore.upsertNode() with idempotent conflict handling"
```

---

## Task 2: `mergeEntities` Phase 2 — edge re-pointing and secondary deletion

**Files:**
- Create: `src/memory/entity-memory.upsert.test.ts`
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Create the test file with failing Phase 2 tests**

Create `src/memory/entity-memory.upsert.test.ts`:

```ts
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

describe('EntityMemory.mergeEntities Phase 2', () => {
  it('re-points secondary edges to primary after merge', async () => {
    const mem = makeEntityMemory();
    const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });
    const org = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });

    // secondary has a relationship with org
    await mem.upsertEdge(secondary.entity.id, org.entity.id, 'member_of', {}, 'test', 0.8);

    await mem.mergeEntities(primary.entity.id, secondary.entity.id);

    // secondary node is gone
    expect(await mem.getEntity(secondary.entity.id)).toBeUndefined();

    // primary now has the edge to org
    const edges = await mem.findEdges(primary.entity.id);
    expect(edges.some(e => e.node.id === org.entity.id && e.edge.type === 'member_of')).toBe(true);
  });

  it('does not duplicate edges that primary already has', async () => {
    const mem = makeEntityMemory();
    const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });
    const org = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });

    // both nodes already have the same relationship with org
    await mem.upsertEdge(primary.entity.id, org.entity.id, 'member_of', {}, 'test', 0.7);
    await mem.upsertEdge(secondary.entity.id, org.entity.id, 'member_of', {}, 'test', 0.9);

    await mem.mergeEntities(primary.entity.id, secondary.entity.id);

    const edges = await mem.findEdges(primary.entity.id);
    const memberOfEdges = edges.filter(e => e.edge.type === 'member_of' && e.node.id === org.entity.id);
    // exactly one edge, not two
    expect(memberOfEdges).toHaveLength(1);
    // confidence raised to the higher value
    expect(memberOfEdges[0]!.edge.temporal.confidence).toBe(0.9);
  });

  it('deletes the secondary node after merge', async () => {
    const mem = makeEntityMemory();
    const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });

    await mem.mergeEntities(primary.entity.id, secondary.entity.id);

    expect(await mem.getEntity(secondary.entity.id)).toBeUndefined();
  });

  it('cleans up secondary fact nodes after merge (no orphans)', async () => {
    const mem = makeEntityMemory();
    const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });

    await mem.storeFact({
      entityNodeId: secondary.entity.id,
      label: 'title: CEO',
      properties: {},
      confidence: 0.8,
      source: 'test',
    });

    // get the secondary fact node ID before merge
    const preMergeFacts = await mem.getFacts(secondary.entity.id);
    expect(preMergeFacts).toHaveLength(1);
    const secondaryFactId = preMergeFacts[0]!.id;

    await mem.mergeEntities(primary.entity.id, secondary.entity.id);

    // secondary fact node itself is deleted (not orphaned)
    expect(await mem.getEntity(secondaryFactId)).toBeUndefined();

    // primary has the fact (re-stored in Phase 1)
    const primaryFacts = await mem.getFacts(primary.entity.id);
    expect(primaryFacts.some(f => f.label === 'title: CEO')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test -- --reporter=verbose src/memory/entity-memory.upsert.test.ts
```

Expected: FAIL — `secondary.entity is undefined` (because `createEntity` still returns `KgNode` not `{ entity, created }`)

> Note: tests reference `primary.entity.id` and `secondary.entity.id` because Task 4 will change `createEntity` return type. For now the tests will fail because of the type mismatch — that's expected. We'll fix `createEntity` in Task 4.

**Temporarily rewrite these tests to call `createEntity` with the current return type** so Phase 2 tests can be validated independently. Replace `.entity.id` with `.id` in just this file for now:

```ts
// Temporary: current createEntity returns KgNode directly
const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
const secondary = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });
const org = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });
// use primary.id, secondary.id, org.id
```

Then run tests — expected: FAIL because mergeEntities doesn't delete secondary yet.

- [ ] **Step 3: Implement Phase 2 in `mergeEntities`**

In `src/memory/entity-memory.ts`, replace the `@TODO Phase 2` block at the end of `mergeEntities` (lines 349–354) with:

```ts
    // Phase 2: Re-point secondary's entity relationship edges to primary.
    // We iterate all edges on secondary and upsert equivalent edges on primary.
    // upsertEdge handles the bidirectional uniqueness constraint atomically —
    // if primary already has the same edge, confidence is raised rather than
    // creating a duplicate. Edges to fact nodes are skipped — facts were
    // already re-stored on primary in Phase 1 via storeFact().
    const secondaryEdges = await this.store.getEdgesForNode(secondaryId);
    const secondaryFactNodeIds: string[] = [];

    for (const edge of secondaryEdges) {
      const isOutbound = edge.sourceNodeId === secondaryId;
      const otherId = isOutbound ? edge.targetNodeId : edge.sourceNodeId;

      // Self-loop guard (should not exist, but be defensive)
      if (otherId === secondaryId) continue;

      const otherNode = await this.store.getNode(otherId);
      if (!otherNode) continue;

      if (otherNode.type === FACT_TYPE) {
        // Collect secondary fact node IDs for cleanup after edge transfer.
        // These were re-stored on primary in Phase 1; deleting them here
        // prevents orphaned fact nodes after the secondary entity is removed.
        secondaryFactNodeIds.push(otherId);
        continue;
      }

      // Transfer the relationship edge to primary
      await this.store.upsertEdge({
        sourceNodeId: isOutbound ? primaryId : otherId,
        targetNodeId: isOutbound ? otherId : primaryId,
        type: edge.type,
        properties: edge.properties,
        confidence: edge.temporal.confidence,
        decayClass: edge.temporal.decayClass,
        source: edge.temporal.source,
      });
    }

    // Delete secondary's fact nodes (already re-created on primary in Phase 1).
    // Must happen before deleteNode so cascade doesn't beat us to it.
    for (const factNodeId of secondaryFactNodeIds) {
      await this.store.deleteNode(factNodeId);
    }

    // Delete the secondary entity node. ON DELETE CASCADE on kg_edges removes
    // any remaining edges (e.g. self-loops or edges not transferred above).
    await this.store.deleteNode(secondaryId);
```

- [ ] **Step 4: Run tests to confirm Phase 2 tests pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test -- --reporter=verbose src/memory/entity-memory.upsert.test.ts
```

Expected: All Phase 2 tests PASS.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness add src/memory/entity-memory.ts src/memory/entity-memory.upsert.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness commit -m "feat: complete mergeEntities Phase 2 — edge re-pointing and secondary node deletion"
```

---

## Task 3: `EntityMemory.updateNode()` — public method with merge-on-collision

**Files:**
- Modify: `src/memory/entity-memory.upsert.test.ts`
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Add failing `updateNode` tests to `entity-memory.upsert.test.ts`**

Append a new describe block to `src/memory/entity-memory.upsert.test.ts`:

```ts
describe('EntityMemory.updateNode', () => {
  it('updates properties without merge when no label change', async () => {
    const mem = makeEntityMemory();
    const node = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });

    const { node: updated, merged } = await mem.updateNode(node.id, { properties: { role: 'CEO' } });

    expect(merged).toBe(false);
    expect(updated.id).toBe(node.id);
    expect(updated.properties).toEqual({ role: 'CEO' });
  });

  it('updates label without merge when no collision', async () => {
    const mem = makeEntityMemory();
    const node = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });

    const { node: updated, merged } = await mem.updateNode(node.id, { label: 'Joseph' });

    expect(merged).toBe(false);
    expect(updated.id).toBe(node.id);
    expect(updated.label).toBe('Joseph');
  });

  it('merges nodes when label update collides with an existing node of the same type', async () => {
    const mem = makeEntityMemory();
    const canonical = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const toRename = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });

    const { node: result, merged } = await mem.updateNode(toRename.id, { label: 'Joseph Fung' });

    expect(merged).toBe(true);
    // Returned node is the canonical, not the renamed node
    expect(result.id).toBe(canonical.id);
    // The renamed node no longer exists
    expect(await mem.getEntity(toRename.id)).toBeUndefined();
  });

  it('does NOT merge when same label but different type', async () => {
    const mem = makeEntityMemory();
    await mem.createEntity({ type: 'organization', label: 'Apple', properties: {}, source: 'test' });
    const concept = await mem.createEntity({ type: 'concept', label: 'Fruit', properties: {}, source: 'test' });

    // Renaming concept to 'Apple' — no collision because types differ
    const { merged } = await mem.updateNode(concept.id, { label: 'Apple' });

    expect(merged).toBe(false);
  });

  it('transfers edges to canonical on merge-on-collision', async () => {
    const mem = makeEntityMemory();
    const canonical = await mem.createEntity({ type: 'person', label: 'Joseph Fung', properties: {}, source: 'test' });
    const toRename = await mem.createEntity({ type: 'person', label: 'Joe', properties: {}, source: 'test' });
    const org = await mem.createEntity({ type: 'organization', label: 'Acme', properties: {}, source: 'test' });

    await mem.upsertEdge(toRename.id, org.id, 'member_of', {}, 'test', 0.8);

    await mem.updateNode(toRename.id, { label: 'Joseph Fung' });

    const edges = await mem.findEdges(canonical.id);
    expect(edges.some(e => e.node.id === org.id && e.edge.type === 'member_of')).toBe(true);
  });
});
```

Note: these tests reference `.id` directly on the `createEntity` result. They will need updating once Task 4 changes the return type. For now, use the current return type (`KgNode`).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test -- --reporter=verbose src/memory/entity-memory.upsert.test.ts
```

Expected: FAIL — `mem.updateNode is not a function`

- [ ] **Step 3: Add `updateNode` to `EntityMemory`**

In `src/memory/entity-memory.ts`, add after `getEntity`:

```ts
  /**
   * Update a node's label and/or properties.
   *
   * ╔══════════════════════════════════════════════════════════════════════╗
   * ║  IMPORTANT — READ BEFORE CALLING THIS METHOD                        ║
   * ║                                                                      ║
   * ║  When `updates.label` is provided, this method checks whether the   ║
   * ║  new label collides with an existing node of the same type.         ║
   * ║  If a collision is found, the two nodes are MERGED — the existing   ║
   * ║  node becomes canonical and the node you passed in is DELETED.      ║
   * ║                                                                      ║
   * ║  When merged === true:                                               ║
   * ║    • node.id in the result is DIFFERENT from the id you passed in   ║
   * ║    • The original id no longer exists in the knowledge graph        ║
   * ║    • You MUST update any local reference to the old id              ║
   * ║    • Surface this to the agent — it needs to know the canonical id  ║
   * ║                                                                      ║
   * ║  Example:                                                            ║
   * ║    const { node, merged } = await entityMemory.updateNode(          ║
   * ║      joeId, { label: 'Joseph Fung' }                                ║
   * ║    );                                                                ║
   * ║    if (merged) {                                                     ║
   * ║      // joeId is gone. node.id is the canonical Joseph Fung node.   ║
   * ║      // Log, surface to the agent, update your local reference.     ║
   * ║    }                                                                 ║
   * ╚══════════════════════════════════════════════════════════════════════╝
   */
  async updateNode(
    id: string,
    updates: { label?: string; properties?: Record<string, unknown> },
  ): Promise<{ node: KgNode; merged: boolean }> {
    if (!updates.label) {
      // Properties-only update — no collision possible, simple pass-through
      const node = await this.store.updateNode(id, updates);
      return { node, merged: false };
    }

    // Label change: check for a collision with an existing node of the same type
    const current = await this.store.getNode(id);
    if (!current) throw new Error(`Node not found: ${id}`);

    if (current.type !== FACT_TYPE) {
      const candidates = await this.store.findNodesByLabel(updates.label);
      const collision = candidates.find(n => n.type === current.type && n.id !== id);

      if (collision) {
        // Merge: the existing node is canonical; the node being renamed is secondary.
        // mergeEntities handles property merge, fact migration, edge re-pointing,
        // and deletion of the secondary node.
        await this.mergeEntities(collision.id, id);
        // Re-fetch canonical to get post-merge state (properties may have been updated)
        const canonical = await this.store.getNode(collision.id);
        if (!canonical) throw new Error(`Canonical node not found after merge: ${collision.id}`);
        return { node: canonical, merged: true };
      }
    }

    // No collision — proceed with normal label update
    const node = await this.store.updateNode(id, updates);
    return { node, merged: false };
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test -- --reporter=verbose src/memory/entity-memory.upsert.test.ts
```

Expected: All `updateNode` tests PASS. All `mergeEntities` tests still PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness add src/memory/entity-memory.ts src/memory/entity-memory.upsert.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness commit -m "feat: add EntityMemory.updateNode() with merge-on-collision for label changes"
```

---

## Task 4: `createEntity` return type change + call-site updates

This task changes `createEntity` from returning `KgNode` to `{ entity: KgNode; created: boolean }`. It will break several TypeScript call sites — fix them all in one commit.

**Files:**
- Modify: `src/memory/entity-memory.ts`
- Modify: `src/memory/entity-memory.upsert.test.ts`
- Modify: `src/memory/entity-memory.edges.test.ts`
- Modify: `src/contacts/contact-service.ts`
- Modify: `skills/extract-relationships/handler.ts`
- Modify: `skills/knowledge-meeting-links/handler.ts`
- Modify: `skills/_shared/template-base.ts`
- Modify: `skills/query-relationships/handler.test.ts`
- Modify: `skills/delete-relationship/handler.test.ts`

- [ ] **Step 1: Add failing `createEntity` return-type tests to `entity-memory.upsert.test.ts`**

Append a new describe block to `src/memory/entity-memory.upsert.test.ts`:

```ts
describe('EntityMemory.createEntity', () => {
  it('returns { entity, created: true } on first call', async () => {
    const mem = makeEntityMemory();

    const result = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });

    expect(result.created).toBe(true);
    expect(result.entity.label).toBe('Alice');
    expect(result.entity.type).toBe('person');
  });

  it('returns { entity, created: false } on second call with same (label, type)', async () => {
    const mem = makeEntityMemory();

    const first = await mem.createEntity({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    const second = await mem.createEntity({ type: 'person', label: 'ALICE', properties: {}, source: 'test' });

    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
  });

  it('returns created: true for same label under different types', async () => {
    const mem = makeEntityMemory();

    const r1 = await mem.createEntity({ type: 'person', label: 'Apple', properties: {}, source: 'test' });
    const r2 = await mem.createEntity({ type: 'organization', label: 'Apple', properties: {}, source: 'test' });

    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r1.entity.id).not.toBe(r2.entity.id);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test -- --reporter=verbose src/memory/entity-memory.upsert.test.ts
```

Expected: FAIL — `result.created is undefined` (returns `KgNode` not `{ entity, created }`)

- [ ] **Step 3: Change `createEntity` in `entity-memory.ts`**

Replace the existing `createEntity` method body:

```ts
  async createEntity(options: CreateEntityOptions): Promise<{ entity: KgNode; created: boolean }> {
    const { node, created } = await this.store.upsertNode({
      type: options.type,
      label: options.label,
      properties: options.properties,
      source: options.source,
      confidence: options.confidence ?? 0.7,
    });
    return { entity: node, created };
  }
```

- [ ] **Step 4: Fix `entity-memory.upsert.test.ts` — update Phase 2 and updateNode tests**

In `src/memory/entity-memory.upsert.test.ts`, update all `createEntity` calls in the Phase 2 and `updateNode` describe blocks to destructure `entity`:

```ts
// Before:
const primary = await mem.createEntity({ type: 'person', label: 'Joseph Fung', ... });
await mem.upsertEdge(primary.id, ...);

// After:
const { entity: primary } = await mem.createEntity({ type: 'person', label: 'Joseph Fung', ... });
await mem.upsertEdge(primary.id, ...);
```

Apply this pattern to every `createEntity` call in the file except the new `createEntity` describe block (which already uses the new return type).

- [ ] **Step 5: Fix `entity-memory.edges.test.ts`**

In `src/memory/entity-memory.edges.test.ts`, update all `createEntity` calls:

```ts
// Before:
const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', ... });
await mem.upsertEdge(joseph.id, xiaopu.id, ...);

// After:
const { entity: joseph } = await mem.createEntity({ type: 'person', label: 'Joseph', ... });
await mem.upsertEdge(joseph.id, xiaopu.id, ...);
```

Apply to every `createEntity` call in the file.

- [ ] **Step 6: Fix `skills/query-relationships/handler.test.ts`**

Two changes needed:

**a)** Update all `createEntity` calls that use the return value:

```ts
// Before:
const joseph = await mem.createEntity({ type: 'person', label: 'Joseph Fung', ... });
await mem.upsertEdge(joseph.id, xiaopu.id, ...);

// After:
const { entity: joseph } = await mem.createEntity({ type: 'person', label: 'Joseph Fung', ... });
await mem.upsertEdge(joseph.id, xiaopu.id, ...);
```

**b)** The "ambiguous" test (line 73–87) creates two nodes with the same label to trigger `ambiguous: true`. After the return type change, the second `createEntity` call returns `created: false` and the same node — only one node exists. The test must be rewritten to insert a duplicate directly via `store.createNode()`, bypassing the upsert:

```ts
it('returns ambiguous:true with candidates when multiple nodes match', async () => {
  // createEntity uses upsertNode which prevents duplicates.
  // To test the ambiguous code path (pre-migration data or direct DB insert),
  // we insert a second node directly via the store, bypassing dedup logic.
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  const mem = new EntityMemory(store, validator, embeddingService);

  // Create first node via normal path
  await mem.createEntity({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });
  // Insert second node directly to bypass upsert (simulates pre-migration duplicate)
  await store.createNode({ type: 'person', label: 'John Smith', properties: {}, source: 'test' });

  const handler = new QueryRelationshipsHandler();
  const ctx = makeCtx(mem, { entity: 'John Smith' });
  const result = await handler.execute(ctx);

  expect(result.success).toBe(true);
  const data = (result as { success: true; data: { ambiguous: boolean; candidates: unknown[] } }).data;
  expect(data.ambiguous).toBe(true);
  expect(data.candidates).toHaveLength(2);
});
```

This requires importing `KnowledgeGraphStore`, `EmbeddingService`, `MemoryValidator`, and `EntityMemory` at the top of the test file. Check what's already imported and add what's missing.

- [ ] **Step 7: Fix `skills/delete-relationship/handler.test.ts`**

Update all `createEntity` calls to destructure `{ entity }`:

```ts
// Before:
const joseph = await mem.createEntity({ type: 'person', label: 'Joseph', ... });

// After:
const { entity: joseph } = await mem.createEntity({ type: 'person', label: 'Joseph', ... });
```

- [ ] **Step 8: Fix `skills/extract-relationships/handler.ts`**

The two `createEntity` calls are the fallback in a nullish-coalescing chain. Change:

```ts
// Before (lines ~183 and ~196):
const subjectNode =
  subjectMatches.find(n => n.type === subjectType) ??
  subjectMatches[0] ??
  await ctx.entityMemory.createEntity({
    type: subjectType,
    label: triple.subject,
    properties: {},
    source,
    confidence: 0.6,
  });

// After:
const subjectMatch = subjectMatches.find(n => n.type === subjectType) ?? subjectMatches[0];
const subjectNode = subjectMatch ?? (await ctx.entityMemory.createEntity({
  type: subjectType,
  label: triple.subject,
  properties: {},
  source,
  confidence: 0.6,
})).entity;
```

Apply the same pattern for the `objectNode` resolution (~line 196).

- [ ] **Step 9: Fix `skills/knowledge-meeting-links/handler.ts`**

In `findOrCreateAnchor`, the method returns the `createEntity` result directly and the caller uses `.id`:

```ts
// Before:
private async findOrCreateAnchor(ctx: SkillContext) {
  const existing = await ctx.entityMemory!.findEntities(ANCHOR_LABEL);
  if (existing.length > 0) {
    return existing[0]!;
  }

  return ctx.entityMemory!.createEntity({
    type: 'concept',
    label: ANCHOR_LABEL,
    properties: { category: 'meeting-knowledge' },
    source: 'skill:knowledge-meeting-links',
  });
}

// After:
private async findOrCreateAnchor(ctx: SkillContext) {
  const existing = await ctx.entityMemory!.findEntities(ANCHOR_LABEL);
  if (existing.length > 0) {
    return existing[0]!;
  }

  const { entity } = await ctx.entityMemory!.createEntity({
    type: 'concept',
    label: ANCHOR_LABEL,
    properties: { category: 'meeting-knowledge' },
    source: 'skill:knowledge-meeting-links',
  });
  return entity;
}
```

- [ ] **Step 10: Fix `skills/_shared/template-base.ts`**

```ts
// Before:
const anchor = await ctx.entityMemory!.createEntity({
  type: 'concept',
  label: templateLabel,
  properties: { category: 'email-policy' },
  source: skillSource,
});
return anchor.id;

// After:
const { entity: anchor } = await ctx.entityMemory!.createEntity({
  type: 'concept',
  label: templateLabel,
  properties: { category: 'email-policy' },
  source: skillSource,
});
return anchor.id;
```

- [ ] **Step 11: Fix `src/contacts/contact-service.ts`**

```ts
// Before (lines ~163–173):
let kgNodeId: string | null = options.kgNodeId ?? null;
if (!kgNodeId && this.entityMemory) {
  const entity = await this.entityMemory.createEntity({
    type: 'person',
    label: safeName,
    properties: options.role ? { role: options.role } : {},
    source: options.source,
  });
  kgNodeId = entity.id;
}

// After:
let kgNodeId: string | null = options.kgNodeId ?? null;
if (!kgNodeId && this.entityMemory) {
  const { entity, created } = await this.entityMemory.createEntity({
    type: 'person',
    label: safeName,
    properties: options.role ? { role: options.role } : {},
    source: options.source,
  });
  if (!created && options.role) {
    // A KG node already existed for this label. Apply the role property if
    // it isn't already set — the existing node may have been created without
    // one (e.g. by extract-relationships which always passes empty properties).
    const { node } = await this.entityMemory.updateNode(entity.id, {
      properties: { ...entity.properties, role: options.role },
    });
    kgNodeId = node.id;
  } else {
    kgNodeId = entity.id;
  }
}
```

- [ ] **Step 12: Run full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test
```

Expected: All tests PASS. No TypeScript errors.

- [ ] **Step 13: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness add \
  src/memory/entity-memory.ts \
  src/memory/entity-memory.upsert.test.ts \
  src/memory/entity-memory.edges.test.ts \
  src/contacts/contact-service.ts \
  skills/extract-relationships/handler.ts \
  skills/knowledge-meeting-links/handler.ts \
  skills/_shared/template-base.ts \
  skills/query-relationships/handler.test.ts \
  skills/delete-relationship/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness commit -m "feat: change createEntity() to return { entity, created } and update all call sites"
```

---

## Task 5: Migration `016_kg_node_uniqueness.sql`

**Files:**
- Create: `src/db/migrations/016_kg_node_uniqueness.sql`

- [ ] **Step 1: Create the migration file**

Create `src/db/migrations/016_kg_node_uniqueness.sql`:

```sql
-- Up Migration

-- Step 1: Build a map of (duplicate_id → canonical_id) for all non-fact node groups
-- with more than one member. Canonical = highest confidence, ties by oldest created_at.
CREATE TEMP TABLE _kg_node_canonical AS
SELECT
  dup.id   AS duplicate_id,
  canon.id AS canonical_id
FROM kg_nodes dup
JOIN (
  -- One canonical node per (lower(label), type) group
  SELECT DISTINCT ON (lower(label), type)
    id,
    lower(label) AS lower_label,
    type
  FROM kg_nodes
  WHERE type != 'fact'
  ORDER BY lower(label), type, confidence DESC, created_at ASC
) canon
  ON  lower(dup.label) = canon.lower_label
  AND dup.type         = canon.type
  AND dup.id          != canon.id
WHERE dup.type != 'fact';

-- Step 2: Delete edges that would conflict with the bidirectional unique index
-- after re-pointing. An edge conflicts if the canonical already has an edge of
-- the same type connecting the same two node IDs in either direction.
DELETE FROM kg_edges e
USING _kg_node_canonical m
WHERE (e.source_node_id = m.duplicate_id OR e.target_node_id = m.duplicate_id)
  AND EXISTS (
    SELECT 1 FROM kg_edges existing
    WHERE existing.id != e.id
      AND existing.type = e.type
      AND LEAST(existing.source_node_id::text, existing.target_node_id::text) =
            LEAST(
              CASE WHEN e.source_node_id = m.duplicate_id THEN m.canonical_id ELSE e.source_node_id END,
              CASE WHEN e.target_node_id = m.duplicate_id THEN m.canonical_id ELSE e.target_node_id END
            )::text
      AND GREATEST(existing.source_node_id::text, existing.target_node_id::text) =
            GREATEST(
              CASE WHEN e.source_node_id = m.duplicate_id THEN m.canonical_id ELSE e.source_node_id END,
              CASE WHEN e.target_node_id = m.duplicate_id THEN m.canonical_id ELSE e.target_node_id END
            )::text
  );

-- Step 3: Re-point remaining edges to the canonical node
UPDATE kg_edges
SET source_node_id = m.canonical_id
FROM _kg_node_canonical m
WHERE source_node_id = m.duplicate_id;

UPDATE kg_edges
SET target_node_id = m.canonical_id
FROM _kg_node_canonical m
WHERE target_node_id = m.duplicate_id;

-- Step 4: Re-point contacts.kg_node_id to canonical.
-- If the canonical node already has a contact, NULL out the duplicate's FK
-- to avoid violating the partial unique index on contacts(kg_node_id).
-- The nulled-out contact row should be merged via the contact-merge flow.
UPDATE contacts
SET kg_node_id = CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM contacts c2
    WHERE c2.kg_node_id = m.canonical_id
      AND c2.id != contacts.id
  ) THEN m.canonical_id
  ELSE NULL
END
FROM _kg_node_canonical m
WHERE contacts.kg_node_id = m.duplicate_id;

-- Step 5: Delete duplicate nodes (ON DELETE CASCADE removes remaining edges)
DELETE FROM kg_nodes
WHERE id IN (SELECT duplicate_id FROM _kg_node_canonical);

DROP TABLE _kg_node_canonical;

-- Step 6: Enforce uniqueness going forward.
-- Excludes fact nodes — facts are intentionally many-per-entity.
-- Allows same label under different types (e.g. "Apple" org vs "Apple" concept).
CREATE UNIQUE INDEX idx_kg_nodes_unique
  ON kg_nodes (lower(label), type)
  WHERE type != 'fact';

-- Down Migration
DROP INDEX IF EXISTS idx_kg_nodes_unique;
-- Note: the dedup data changes are not reversible.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness add src/db/migrations/016_kg_node_uniqueness.sql
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness commit -m "chore: migration 016 — dedup kg_nodes and add uniqueness constraint on (lower(label), type)"
```

---

## Task 6: Changelog and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add changelog entry**

In `CHANGELOG.md`, add under `## [Unreleased]`:

```markdown
### Fixed
- **KG node deduplication** — one-time migration deduplicates existing `kg_nodes` rows with matching `(lower(label), type)`, re-pointing edges and contacts to canonical nodes before removing duplicates.

### Added
- **`kg_nodes` uniqueness constraint** — `idx_kg_nodes_unique` on `(lower(label), type) WHERE type != 'fact'` prevents future duplicate entity nodes.
- **`KnowledgeGraphStore.upsertNode()`** — idempotent node creation; raises confidence on conflict, never creates duplicates. Returns `{ node, created }`.
- **`EntityMemory.createEntity()`** — now returns `{ entity, created }` instead of `KgNode`. Delegates to `upsertNode` for race-safe creation. **Breaking change** for callers (all internal call sites updated).
- **`EntityMemory.updateNode()`** — new public method. Label changes that collide with an existing node of the same type automatically merge the nodes. Returns `{ node, merged }` — callers must use the returned `node.id`, which may differ from the input id when `merged: true`.
- **`mergeEntities` Phase 2** — re-points secondary entity edges to primary and deletes the secondary node (was previously deferred with a TODO).
```

- [ ] **Step 2: Bump version in `package.json`**

Change `"version": "0.12.1"` to `"version": "0.12.2"`.

- [ ] **Step 3: Run full test suite one final time**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness run test
```

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-kg-node-uniqueness commit -m "chore: bump version to 0.12.2 and update changelog for kg-node-uniqueness"
```

---

## Self-Review Checklist

- [x] `upsertNode` in both backends with `created` flag — Task 1
- [x] `mergeEntities` Phase 2: edge re-pointing, secondary fact node cleanup, secondary deletion — Task 2
- [x] `updateNode` public method with merge-on-collision, strong directive comment — Task 3
- [x] `createEntity` return type change + all call sites updated — Task 4
- [x] `contact-service` applies `role` on `!created` — Task 4, Step 11
- [x] `query-relationships` ambiguous test fixed for new upsert semantics — Task 4, Step 6b
- [x] Migration: dedup, edge conflict resolution, contacts re-pointing, delete, unique index — Task 5
- [x] Changelog + version bump — Task 6
