# Alias Propagation Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three alias propagation gaps in the knowledge graph: make `addAlias` atomic at the DB level, have `mergeEntities` union aliases from both nodes, and add an exact alias-match path to `EntityMemory.search`.

**Architecture:** All changes live in `src/memory/` — specifically `knowledge-graph.ts` (backend interface + both implementations + store pass-through) and `entity-memory.ts` (`addAlias`, `mergeEntities`, `search`). No changes are needed to the `memory-query` skill handler — the improved `search()` is transparent to callers.

**Tech Stack:** TypeScript ESM, Vitest, Postgres (pgvector), in-memory backend for tests.

---

## Task 1: Write failing tests for `KnowledgeGraphStore.addAlias`

**Files:**
- Modify: `src/memory/knowledge-graph.upsert.test.ts`

- [ ] **Step 1: Add the failing test suite to `knowledge-graph.upsert.test.ts`**

Append this block at the end of the file (after existing `describe` blocks):

```typescript
describe('KnowledgeGraphStore.addAlias', () => {
  it('returns true and appends alias when alias is new', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });

    const added = await store.addAlias(node.id, 'al');

    expect(added).toBe(true);
    const updated = await store.getNode(node.id);
    expect(updated!.aliases).toEqual(['al']);
  });

  it('returns false and does not duplicate when alias already exists', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    await store.addAlias(node.id, 'al');

    const added = await store.addAlias(node.id, 'al');

    expect(added).toBe(false);
    const updated = await store.getNode(node.id);
    expect(updated!.aliases).toEqual(['al']); // still exactly one copy
  });

  it('returns false when alias cap (10) is reached', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Alice', properties: {}, source: 'test' });
    for (let i = 0; i < 10; i++) {
      await store.addAlias(node.id, `alias-${i}`);
    }

    const added = await store.addAlias(node.id, 'one-more');

    expect(added).toBe(false);
    const updated = await store.getNode(node.id);
    expect(updated!.aliases).toHaveLength(10);
    expect(updated!.aliases).not.toContain('one-more');
  });

  it('returns false for an unknown nodeId', async () => {
    const store = makeStore();

    const added = await store.addAlias('does-not-exist', 'some-alias');

    expect(added).toBe(false);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
npx --prefix /Users/josephfung/Projects/worktrees/curia-alias-propagation vitest run src/memory/knowledge-graph.upsert.test.ts
```

Expected: FAIL — `store.addAlias is not a function` (or equivalent TypeError).

---

## Task 2: Implement `addAlias` in the backend interface, both backends, and the store

**Files:**
- Modify: `src/memory/knowledge-graph.ts`

- [ ] **Step 1: Add `addAlias` to the `KnowledgeGraphBackend` interface**

In `src/memory/knowledge-graph.ts`, find the `KnowledgeGraphBackend` interface (starts around line 70). After the `findNodesByLabel` line, insert:

```typescript
  /** Atomically append an alias to a node's aliases array.
   *  Returns true if the alias was appended, false if skipped
   *  (already present, cap reached, or node not found). */
  addAlias(nodeId: string, alias: string): Promise<boolean>;
```

- [ ] **Step 2: Implement `PostgresBackend.addAlias`**

In `src/memory/knowledge-graph.ts`, find `PostgresBackend.findNodesByLabel` (around line 523). After its closing brace, add:

```typescript
  async addAlias(nodeId: string, alias: string): Promise<boolean> {
    // Single atomic UPDATE: predicate enforces dedup and cap at the DB level.
    // No SELECT needed — rowCount tells us whether the guard passed.
    const result = await this.pool.query(
      `UPDATE kg_nodes
       SET aliases = array_append(aliases, $2)
       WHERE id = $1
         AND archived_at IS NULL
         AND NOT ($2 = ANY(aliases))
         AND cardinality(aliases) < 10`,
      [nodeId, alias],
    );
    return (result.rowCount ?? 0) > 0;
  }
```

- [ ] **Step 3: Implement `InMemoryBackend.addAlias`**

In `src/memory/knowledge-graph.ts`, find `InMemoryBackend.findNodesByLabel` (around line 979). After its closing brace, add:

```typescript
  async addAlias(nodeId: string, alias: string): Promise<boolean> {
    // JS is single-threaded so no true race exists, but this mirrors the
    // Postgres predicate semantics so in-memory tests are reliable proxies.
    const node = this.nodes.get(nodeId);
    if (!node || this.archivedNodes.has(nodeId)) return false;
    if (node.aliases.includes(alias)) return false;
    if (node.aliases.length >= 10) return false;
    this.nodes.set(nodeId, { ...node, aliases: [...node.aliases, alias] });
    return true;
  }
```

- [ ] **Step 4: Add `addAlias` pass-through to `KnowledgeGraphStore`**

In `src/memory/knowledge-graph.ts`, find `KnowledgeGraphStore.findNodesByLabel` (around line 283). After its closing brace, add:

```typescript
  /** Atomically append an alias — see KnowledgeGraphBackend.addAlias for semantics. */
  addAlias(nodeId: string, alias: string): Promise<boolean> {
    return this.backend.addAlias(nodeId, alias);
  }
```

- [ ] **Step 5: Run the store tests to verify they pass**

```bash
npx --prefix /Users/josephfung/Projects/worktrees/curia-alias-propagation vitest run src/memory/knowledge-graph.upsert.test.ts
```

Expected: all tests PASS, including the four new `KnowledgeGraphStore.addAlias` tests.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-alias-propagation add src/memory/knowledge-graph.ts src/memory/knowledge-graph.upsert.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-alias-propagation commit -m "feat: add atomic addAlias to KnowledgeGraphBackend interface and both backends"
```

---

## Task 3: Update `entity-memory.addAlias` to use `store.addAlias`

**Files:**
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Replace the body of `entity-memory.addAlias`**

In `src/memory/entity-memory.ts`, find `async addAlias` (around line 417). Replace its body with:

```typescript
  async addAlias(nodeId: string, alias: string): Promise<void> {
    // Non-throwing contract: alias learning must never block fact storage.
    try {
      const lowerAlias = alias.toLowerCase();

      // Reading the node here serves two purposes: canonical-label check (the
      // backend predicate cannot cover this since the label is not in the aliases
      // array) and cap-warning logging. The actual dedup+cap guard is atomic in
      // the backend, so this read is for logging only — not for correctness.
      const node = await this.store.getNode(nodeId);
      if (!node) {
        this.logger.warn({ nodeId, alias }, 'addAlias: entity node not found');
        return;
      }

      // Skip if alias matches the canonical label (backend predicate won't catch this)
      if (node.label.toLowerCase() === lowerAlias) {
        return;
      }

      // Log before delegating so the warning appears even if the backend silently rejects.
      if (node.aliases.length >= MAX_ALIASES_PER_ENTITY) {
        this.logger.warn(
          { nodeId, alias, count: node.aliases.length, max: MAX_ALIASES_PER_ENTITY },
          'addAlias: alias cap reached — skipping',
        );
        return;
      }

      await this.store.addAlias(nodeId, lowerAlias);
    } catch (err) {
      this.logger.warn(
        { nodeId, alias, error: err instanceof Error ? err.message : String(err) },
        'addAlias: unexpected error — skipping',
      );
      // Best-effort: do not rethrow
    }
  }
```

- [ ] **Step 2: Run the existing `addAlias` tests to verify nothing broke**

```bash
npx --prefix /Users/josephfung/Projects/worktrees/curia-alias-propagation vitest run src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: all tests PASS (including the existing `EntityMemory.addAlias` describe block).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-alias-propagation add src/memory/entity-memory.ts
git -C /Users/josephfung/Projects/worktrees/curia-alias-propagation commit -m "fix: make addAlias atomic by delegating dedup+cap guard to the backend predicate"
```

---

## Task 4: Write failing tests for `mergeEntities` alias union

**Files:**
- Modify: `src/memory/entity-memory.resolve-or-create.test.ts`

- [ ] **Step 1: Append the failing test suite**

At the end of `src/memory/entity-memory.resolve-or-create.test.ts`, append:

```typescript
describe('EntityMemory.mergeEntities — alias consolidation', () => {
  it('unions secondary aliases into primary on merge', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity: primary } = await mem.createEntity({
      type: 'person', label: 'Jane Doe', properties: {}, source: 'test',
    });
    const { entity: secondary } = await mem.createEntity({
      type: 'person', label: 'Jane', properties: {}, source: 'test',
    });
    await mem.addAlias(primary.id, 'jane-doe');
    await mem.addAlias(secondary.id, 'jane');
    await mem.addAlias(secondary.id, 'j-doe');

    await mem.mergeEntities(primary.id, secondary.id);

    const surviving = await store.getNode(primary.id);
    expect(surviving!.aliases).toContain('jane-doe');  // primary's own alias
    expect(surviving!.aliases).toContain('jane');       // from secondary
    expect(surviving!.aliases).toContain('j-doe');      // from secondary
    // No duplicates
    expect(new Set(surviving!.aliases).size).toBe(surviving!.aliases.length);
  });

  it('deduplicates aliases that appear on both nodes', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity: primary } = await mem.createEntity({
      type: 'person', label: 'Jane Doe', properties: {}, source: 'test',
    });
    const { entity: secondary } = await mem.createEntity({
      type: 'person', label: 'Jane', properties: {}, source: 'test',
    });
    await mem.addAlias(primary.id, 'shared-alias');
    await mem.addAlias(secondary.id, 'shared-alias');
    await mem.addAlias(secondary.id, 'extra');

    await mem.mergeEntities(primary.id, secondary.id);

    const surviving = await store.getNode(primary.id);
    const count = surviving!.aliases.filter(a => a === 'shared-alias').length;
    expect(count).toBe(1);
    expect(surviving!.aliases).toContain('extra');
  });

  it('caps the alias union at MAX_ALIASES_PER_ENTITY and preserves primary aliases first', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity: primary } = await mem.createEntity({
      type: 'person', label: 'Primary', properties: {}, source: 'test',
    });
    const { entity: secondary } = await mem.createEntity({
      type: 'person', label: 'Secondary', properties: {}, source: 'test',
    });

    // Fill primary with 8 aliases
    for (let i = 0; i < 8; i++) {
      await mem.addAlias(primary.id, `primary-alias-${i}`);
    }
    // Give secondary 5 aliases (only 2 can fit into the cap of 10)
    for (let i = 0; i < 5; i++) {
      await mem.addAlias(secondary.id, `secondary-alias-${i}`);
    }

    await mem.mergeEntities(primary.id, secondary.id);

    const surviving = await store.getNode(primary.id);
    expect(surviving!.aliases).toHaveLength(10);
    // All 8 primary aliases are preserved
    for (let i = 0; i < 8; i++) {
      expect(surviving!.aliases).toContain(`primary-alias-${i}`);
    }
    // The first 2 secondary aliases fit; the last 3 are dropped
    expect(surviving!.aliases).toContain('secondary-alias-0');
    expect(surviving!.aliases).toContain('secondary-alias-1');
    expect(surviving!.aliases).not.toContain('secondary-alias-2');
    expect(surviving!.aliases).not.toContain('secondary-alias-3');
    expect(surviving!.aliases).not.toContain('secondary-alias-4');
  });

  it('leaves primary aliases unchanged when secondary has no aliases', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity: primary } = await mem.createEntity({
      type: 'person', label: 'Primary', properties: {}, source: 'test',
    });
    const { entity: secondary } = await mem.createEntity({
      type: 'person', label: 'Secondary', properties: {}, source: 'test',
    });
    await mem.addAlias(primary.id, 'p-alias');
    // secondary has no aliases

    await mem.mergeEntities(primary.id, secondary.id);

    const surviving = await store.getNode(primary.id);
    expect(surviving!.aliases).toEqual(['p-alias']);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npx --prefix /Users/josephfung/Projects/worktrees/curia-alias-propagation vitest run src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: the four new `mergeEntities — alias consolidation` tests FAIL (secondary aliases are currently lost after merge).

---

## Task 5: Implement alias union in `mergeEntities`

**Files:**
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Add alias union step inside `mergeEntities`**

In `src/memory/entity-memory.ts`, find the `mergeEntities` method (around line 795). Locate the line that updates the primary node with merged properties:

```typescript
    // Update primary node with the merged property set
    await this.store.updateNode(primaryId, { properties: mergedProperties });
```

Immediately after that line, before the comment `// Move facts:`, insert the alias union block:

```typescript
    // Union secondary's aliases into primary.
    // Primary's aliases take priority: secondary extras are dropped if combined > cap.
    const newAliases = secondaryNode.aliases.filter(
      a => !primaryNode.aliases.includes(a),
    );
    const combined = [...primaryNode.aliases, ...newAliases];
    const capped = combined.slice(0, MAX_ALIASES_PER_ENTITY);

    if (capped.length < combined.length) {
      this.logger.warn(
        { primaryId, secondaryId, dropped: combined.slice(MAX_ALIASES_PER_ENTITY) },
        'mergeEntities: alias cap reached — dropping excess secondary aliases',
      );
    }

    if (capped.length > primaryNode.aliases.length) {
      await this.store.updateNode(primaryId, { aliases: capped });
    }
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
npx --prefix /Users/josephfung/Projects/worktrees/curia-alias-propagation vitest run src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: all tests PASS, including the four new `mergeEntities — alias consolidation` tests.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-alias-propagation add src/memory/entity-memory.ts
git -C /Users/josephfung/Projects/worktrees/curia-alias-propagation commit -m "feat: mergeEntities now unions aliases from both nodes (deduplicated, capped)"
```

---

## Task 6: Write failing tests for two-path `EntityMemory.search`

**Files:**
- Modify: `src/memory/entity-memory.resolve-or-create.test.ts`

- [ ] **Step 1: Confirm no new imports are needed**

`KnowledgeGraphStore`, `EmbeddingService`, `EntityMemory`, `MemoryValidator`, and `createSilentLogger` are already imported at the top of the file. The test code below uses string literals (`'internal'`, `'restricted'`) rather than the `SENSITIVITY_LEVELS` constant, so no additional imports are needed.

- [ ] **Step 2: Append the failing test suite**

At the end of `src/memory/entity-memory.resolve-or-create.test.ts`, append:

```typescript
describe('EntityMemory.search — alias exact-match path', () => {
  it('surfaces a node via its stored alias with score 1.0', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });
    // The fake embedding for 'darlise' is completely different from 'Darlise Restaurant',
    // so this node won't appear via vector search alone.
    await mem.addAlias(entity.id, 'darlise');

    const results = await mem.search('darlise');

    expect(results.length).toBeGreaterThan(0);
    const match = results.find(r => r.node.id === entity.id);
    expect(match).toBeDefined();
    expect(match!.score).toBe(1.0);
  });

  it('returns an alias-matched node exactly once even when vector search also finds it', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });
    // Alias matches the canonical label (lower-cased) — findNodesByLabel and
    // semanticSearch will both return this node.
    await mem.addAlias(entity.id, 'darlise restaurant');

    const results = await mem.search('darlise restaurant');

    const matches = results.filter(r => r.node.id === entity.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.score).toBe(1.0);
  });

  it('excludes alias-matched nodes that do not match the type filter', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    });
    await mem.addAlias(entity.id, 'darlise');

    // Search for type: 'person' — the organization node should not appear
    const results = await mem.search('darlise', { type: 'person' });

    expect(results.every(r => r.node.id !== entity.id)).toBe(true);
  });

  it('excludes alias-matched nodes above the sensitivity ceiling', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    // Create a restricted node directly via the store to set sensitivity
    const restrictedNode = await store.createNode({
      type: 'person',
      label: 'Private Person',
      properties: {},
      source: 'test',
      sensitivity: 'restricted',
    });
    // Add alias directly via store (bypasses entity-memory.addAlias canonical-label check,
    // which is fine — we just need the alias in the array for this test)
    await store.addAlias(restrictedNode.id, 'private');

    // Search with ceiling of 'internal' — 'restricted' is above that
    const results = await mem.search('private', { maxSensitivity: 'internal' });

    expect(results.every(r => r.node.id !== restrictedNode.id)).toBe(true);
  });

  it('alias-matched nodes appear before lower-scoring vector results', async () => {
    const { mem } = makeEntityMemory();
    // Create two nodes: one with an exact alias match, one that may appear via embedding
    const { entity: aliasNode } = await mem.createEntity({
      type: 'person', label: 'Completely Unrelated Label XYZ', properties: {}, source: 'test',
    });
    await mem.addAlias(aliasNode.id, 'searchterm');

    await mem.createEntity({
      type: 'person', label: 'searchterm adjacent', properties: {}, source: 'test',
    });

    const results = await mem.search('searchterm', { limit: 10 });

    expect(results[0]!.node.id).toBe(aliasNode.id);
    expect(results[0]!.score).toBe(1.0);
  });
});
```

- [ ] **Step 3: Run to confirm they fail**

```bash
npx --prefix /Users/josephfung/Projects/worktrees/curia-alias-propagation vitest run src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: the five new `EntityMemory.search — alias exact-match path` tests FAIL (current implementation only does vector search, never returns score 1.0 for alias matches).

---

## Task 7: Implement two-path `EntityMemory.search`

**Files:**
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Check the import at the top of entity-memory.ts**

Confirm that `SENSITIVITY_LEVELS` is imported. Search for it at the top of the file. If it is not imported (it comes from `'./types.js'`), add it to the import block that already pulls other types from `'./types.js'`:

```typescript
import type {
  KgNode,
  KgEdge,
  NodeType,
  EdgeType,
  Sensitivity,
  StoreFactOptions,
  SearchResult,
} from './types.js';
import { SENSITIVITY_LEVELS } from './types.js';
```

Note: it may already be a `type` import — in that case add a separate value import for `SENSITIVITY_LEVELS`.

- [ ] **Step 2: Replace `EntityMemory.search` with the two-path implementation**

In `src/memory/entity-memory.ts`, find `async search(` (around line 949). Replace the entire method:

```typescript
  /**
   * Search across all nodes using two complementary paths:
   *
   * Path 1 — exact alias/label match (GIN-indexed, no embedding cost):
   *   Calls findNodesByLabel(query) which checks both canonical label and aliases.
   *   Matched nodes receive score 1.0 and are returned first.
   *
   * Path 2 — vector semantic search (existing behaviour):
   *   Embeds the query and finds nodes by cosine similarity.
   *   Nodes already returned by Path 1 are deduplicated.
   *
   * The two paths run concurrently. Results are truncated to `limit` after merging.
   */
  async search(
    query: string,
    options?: { limit?: number; type?: NodeType; maxSensitivity?: Sensitivity },
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;

    // Pre-compute sensitivity ceiling rank for in-process filter on alias results.
    // This mirrors the check inside KnowledgeGraphStore.semanticSearch.
    const maxSensitivityRank =
      options?.maxSensitivity !== undefined
        ? SENSITIVITY_LEVELS.indexOf(options.maxSensitivity)
        : undefined;

    // Run both paths concurrently — they are independent queries.
    const [labelMatches, vectorResults] = await Promise.all([
      this.store.findNodesByLabel(query),
      this.store.semanticSearch(query, options),
    ]);

    // Path 1: filter alias matches in-process (findNodesByLabel has no filter params).
    const aliasMatchIds = new Set<string>();
    const aliasResults: SearchResult[] = [];
    for (const node of labelMatches) {
      if (options?.type && node.type !== options.type) continue;
      if (maxSensitivityRank !== undefined) {
        const nodeRank = SENSITIVITY_LEVELS.indexOf(node.sensitivity);
        // Exclude nodes with unrecognized sensitivity or above the ceiling.
        if (nodeRank === -1 || nodeRank > maxSensitivityRank) continue;
      }
      aliasMatchIds.add(node.id);
      aliasResults.push({ node, score: 1.0, edges: [] });
    }

    // Merge: alias results first, then vector results (dedup by node id).
    const merged: SearchResult[] = [...aliasResults];
    for (const r of vectorResults) {
      if (!aliasMatchIds.has(r.node.id)) {
        merged.push(r);
      }
    }

    return merged.slice(0, limit);
  }
```

- [ ] **Step 3: Run the tests to verify they all pass**

```bash
npx --prefix /Users/josephfung/Projects/worktrees/curia-alias-propagation vitest run src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: all tests PASS, including the five new `EntityMemory.search — alias exact-match path` tests.

- [ ] **Step 4: Run the full test suite to catch any regressions**

```bash
npm --prefix /Users/josephfung/Projects/worktrees/curia-alias-propagation test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-alias-propagation add src/memory/entity-memory.ts
git -C /Users/josephfung/Projects/worktrees/curia-alias-propagation commit -m "feat: EntityMemory.search now checks aliases before vector search (issue #536)"
```
