# Design: Alias Propagation Gaps (issue #536)

**Date:** 2026-05-15  
**Branch:** `fix/alias-propagation-536`  
**Status:** Approved

## Context

PR #534 (fuzzy entity resolution, issue #467) implemented alias-learning and
embedding-based fallback for `resolveOrCreate()`. Three follow-up gaps were
identified:

1. `addAlias` has a race condition — dedup and cap enforcement are not atomic.
2. `mergeEntities` drops the absorbed node's aliases instead of unioning them.
3. `memory-query` ignores the `aliases` column; exact alias matches are missed.

(Item 2 from the original issue — `updateNode` alias-aware collision check — was
confirmed already addressed by the `findNodesByLabel` alias-aware SQL added in
PR #534. No work needed.)

---

## Item 1: Atomic alias dedup in `addAlias`

### Problem

`entity-memory.addAlias` reads `node.aliases`, checks for duplicates, then calls
`store.updateNode` with the appended array. Two concurrent callers (e.g. parallel
`memory-store` invocations on the same entity) can both pass the in-process check
and both write, producing duplicate alias entries.

### Design

Add `addAlias(nodeId: string, alias: string): Promise<boolean>` to the
`KnowledgeGraphBackend` interface. Returns `true` if the alias was appended,
`false` if it was skipped (duplicate, cap reached, or node not found).

**`PostgresBackend.addAlias`** — single atomic UPDATE with a predicate that
enforces both dedup and cap:

```sql
UPDATE kg_nodes
SET aliases = array_append(aliases, $2)
WHERE id = $1
  AND archived_at IS NULL
  AND NOT ($2 = ANY(aliases))
  AND cardinality(aliases) < 10
```

Returns `rowCount > 0`. No SELECT required — the predicate is the guard.

**`InMemoryBackend.addAlias`** — synchronous read-guard (JS is single-threaded
so no true race, but mirrors Postgres semantics for test parity):

```typescript
const node = this.nodes.get(nodeId);
if (!node || this.archivedNodes.has(nodeId)) return false;
if (node.aliases.includes(alias)) return false;
if (node.aliases.length >= MAX_ALIASES_PER_ENTITY) return false;
this.nodes.set(nodeId, { ...node, aliases: [...node.aliases, alias] });
return true;
```

**`KnowledgeGraphStore.addAlias`** — thin pass-through to the backend.

**`entity-memory.addAlias`** — still calls `getNode`, but only for two cheap
in-process purposes:
1. Canonical-label check: skip if the alias matches the node's canonical label
   (the SQL predicate cannot cover this because the canonical label is not stored
   in the `aliases` array).
2. Cap-warning log: if `node.aliases.length >= MAX_ALIASES_PER_ENTITY`, log
   `warn` and return early (the predicate would also reject it, but logging
   requires knowing why).

After those checks, call `this.store.addAlias(nodeId, lowerAlias)`. The
predicate in the backend handles dedup and cap atomically — the in-process read
is for logging only, not for correctness. Even if the node's alias array changes
between the `getNode` read and the `store.addAlias` write (e.g. another process
fills the cap), the predicate rejects the write safely.

Non-throwing contract is preserved — the outer `try/catch` remains.

### Files changed

- `src/memory/knowledge-graph.ts` — backend interface + both implementations + store pass-through
- `src/memory/entity-memory.ts` — `addAlias` simplified

---

## Item 3: `mergeEntities` alias consolidation

### Problem

`mergeEntities(primaryId, secondaryId)` migrates scalar properties, facts, and
relationship edges from the secondary node to the primary node, then deletes the
secondary. It does not touch `aliases`, so the secondary node's learned aliases
are permanently lost.

### Design

After the primary-property update (existing line that calls `store.updateNode`
with `mergedProperties`) and before Phase 2 (edge re-pointing), insert an alias
union step:

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

This uses `store.updateNode` (full array replacement) rather than the new
`store.addAlias` because we are doing a bulk union — one write is preferable to
N individual calls.

**Survivorship rule:** Primary's aliases take priority. Secondary's aliases fill
remaining slots (up to cap 10), in their original order. Any secondary aliases
that don't fit are logged as warnings and dropped.

### Files changed

- `src/memory/entity-memory.ts` — `mergeEntities` alias union step

---

## Item 4: Alias exact-match path in `memory-query`

### Problem

`EntityMemory.search()` delegates entirely to `KnowledgeGraphStore.semanticSearch()`,
which embeds the query and runs a vector similarity query. The `aliases` column is
never consulted. A query for "Darlise" will not reliably surface a node whose
canonical label is "Darlise Restaurant" but which has the alias `"darlise"` stored,
unless the embeddings happen to be close enough.

Once aliases are learned via `resolveOrCreate()`, an exact alias lookup is both
cheaper and more reliable than relying on embedding proximity.

### Design

`EntityMemory.search()` becomes a two-path lookup with in-process merge:

**Path 1 — exact alias/label match** (cheap, GIN-indexed, no embedding):
- Call `this.store.findNodesByLabel(query)`.
- Filter results in-process for `type` and `maxSensitivity` (same logic as vector
  path, since `findNodesByLabel` does not accept these filters).
- Assign score `1.0` to all alias-matched nodes.

**Path 2 — vector semantic search** (existing behaviour):
- Call `this.store.semanticSearch(query, options)` unchanged.

**Concurrency:** Both paths are independent — run them concurrently via
`Promise.all([this.store.findNodesByLabel(query), this.store.semanticSearch(query, options)])`.

**Merge:**
- Start with all alias-matched results (score `1.0`).
- Append vector results, skipping any node ID already present from Path 1.
- Truncate to `limit`.

This ensures alias-matched nodes always appear first. A node that matches both
an alias and the embedding query will appear once, with score `1.0`.

The `memory-query` skill handler (`skills/memory-query/handler.ts`) requires no
changes — it calls `ctx.entityMemory.search()` and the new behaviour is
transparent.

### Sensitivity filter in-process

`findNodesByLabel` returns all matched nodes regardless of sensitivity. The
sensitivity ceiling filter is applied in the merge loop:

```typescript
const maxRank = options?.maxSensitivity
  ? SENSITIVITY_LEVELS.indexOf(options.maxSensitivity)
  : undefined;
// ...
for (const node of labelMatches) {
  if (options?.type && node.type !== options.type) continue;
  if (maxRank !== undefined) {
    const nodeRank = SENSITIVITY_LEVELS.indexOf(node.sensitivity);
    if (nodeRank === -1 || nodeRank > maxRank) continue;
  }
  aliasMatchIds.add(node.id);
  aliasResults.push({ node, score: 1.0, edges: [] });
}
```

### Files changed

- `src/memory/entity-memory.ts` — `search()` two-path lookup

---

## Testing

### Item 1 tests (`entity-memory.resolve-or-create.test.ts` or new file)

- Call `addAlias` twice with the same alias on the same node; assert the aliases
  array contains the alias exactly once.
- Call `addAlias` 10 times with distinct aliases; assert array length stays at
  `MAX_ALIASES_PER_ENTITY` after the cap is reached.
- Call `addAlias` with an alias that matches the canonical label; assert it is skipped.
- In-memory backend: verify `addAlias` returns `false` on dup/cap, `true` on success.

### Item 3 tests (`entity-memory.edges.test.ts` or new file)

- `mergeEntities` where both nodes have aliases: assert the surviving node holds
  the union (deduped).
- `mergeEntities` where combined aliases exceed 10: assert capped at 10, warning
  logged, primary's aliases preserved in full.
- `mergeEntities` where secondary has no aliases: assert no change to primary's
  aliases.

### Item 4 tests (`entity-memory.resolve-or-create.test.ts` or new file)

- `EntityMemory.search` where query matches a stored alias exactly; assert the
  alias-matched node is in results with score `1.0`.
- `EntityMemory.search` where query matches both an alias and a high-scoring
  embedding result for the same node; assert the node appears once with score `1.0`.
- `EntityMemory.search` with `max_sensitivity` filter; assert alias-matched nodes
  above the ceiling are excluded.
- `EntityMemory.search` with `type` filter; assert alias-matched nodes of wrong
  type are excluded.
