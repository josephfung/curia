# Design: KG Node Deduplication and Uniqueness Constraint

**Issue:** josephfung/curia#157
**Date:** 2026-04-08
**Status:** Draft

## Background

`kg_nodes` has no uniqueness constraint on `(label, type)`. Concurrent relationship
extractions can race and create duplicate nodes for the same entity — e.g. two `person`
nodes both labeled "Joseph Fung". The `query-relationships` skill degrades gracefully when
duplicates exist (returns `ambiguous: true`), but the underlying data is messy and will
confuse future queries.

Migration 014 solved the same problem for `kg_edges` by adding a bidirectional unique
index and updating the write path to use `INSERT ... ON CONFLICT DO UPDATE`. This design
applies the same approach to `kg_nodes`.

## Scope

Three pieces of work, in dependency order:

1. **One-time dedup migration** — clean up existing duplicates in the database
2. **Unique constraint** — prevent future duplicates at the DB level
3. **`upsertNode` + updated write path** — make node creation race-safe at the app level

`fact` nodes are excluded from the uniqueness constraint throughout — facts are
intentionally many-per-entity and have no meaningful label uniqueness.

## Design

### 1. Migration `016_kg_node_uniqueness.sql`

#### Dedup pass

For each `(lower(label), type)` group with more than one node where `type != 'fact'`:

- **Pick a canonical node**: highest `confidence`, ties broken by oldest `created_at`
  (the node that has been around longest is the most "established").
- **Re-point `kg_edges`**: `UPDATE kg_edges SET source_node_id = canonical WHERE
  source_node_id = duplicate`, and same for `target_node_id`. Before updating, delete
  any edge that would create a conflict with the bidirectional unique index already on
  `kg_edges` (i.e. canonical already has an equivalent edge in either direction).
- **Re-point `contacts.kg_node_id`**: `UPDATE contacts SET kg_node_id = canonical WHERE
  kg_node_id = duplicate`. If the canonical node already has a contact pointing to it,
  the update would violate the partial unique index on `contacts(kg_node_id)`. In that
  case, NULL out the duplicate's contact FK instead — the two contact rows represent the
  same person and should be merged separately via the contact-merge flow.
- **Delete duplicate nodes**: `DELETE FROM kg_nodes WHERE id = duplicate`. The `ON DELETE
  CASCADE` on `kg_edges` cleans up any edges that were not re-pointed (e.g. edges that
  were left behind because re-pointing would have created a conflict).

The dedup pass runs entirely in SQL within the migration, with no application-layer
involvement.

#### Unique constraint

```sql
CREATE UNIQUE INDEX idx_kg_nodes_unique
  ON kg_nodes (lower(label), type)
  WHERE type != 'fact';
```

This allows:
- "Apple" as an `organization` and "Apple" as a `concept` — different `(label, type)` pairs
- Any number of `fact` nodes with any label — excluded by the partial predicate

### 2. `KnowledgeGraphStore.upsertNode()`

New method, analogous to `upsertEdge()`.

**Signature:**
```ts
async upsertNode(
  options: CreateNodeOptions & { confidence: number }
): Promise<{ node: KgNode; created: boolean }>
```

**Postgres implementation:**
```sql
INSERT INTO kg_nodes (id, type, label, properties, embedding, confidence, decay_class, source, created_at, last_confirmed_at)
VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $9)
ON CONFLICT (lower(label), type) WHERE type != 'fact'
DO UPDATE SET
  confidence = GREATEST(kg_nodes.confidence, EXCLUDED.confidence),
  last_confirmed_at = EXCLUDED.last_confirmed_at
RETURNING *, (created_at = $9) AS is_new
```

On conflict: raises confidence (never lowers), refreshes `last_confirmed_at`. Properties,
label, and embedding of the existing node are left untouched — the caller manages those
explicitly via `updateNode()`.

**InMemory implementation:** scan nodes for matching `(lower(label), type)` where
`type != 'fact'`; if found, update `confidence` and `lastConfirmedAt` and return
`{ node: updated, created: false }`; otherwise insert and return `{ node, created: true }`.

The `KnowledgeGraphBackend` interface gains a corresponding `upsertNode` method.

### 3. `EntityMemory` changes

#### 3a. Expose `updateNode()` publicly — with merge-on-collision

`EntityMemory` gains a public `updateNode()` method. It is not a simple pass-through —
when `updates.label` is present it must guard against the case where the new label
collides with an existing node of the same type (e.g. renaming "Joe" → "Joseph Fung"
when a "Joseph Fung" node already exists).

Updating a label to match an existing node is a signal that the two nodes represent the
same entity. The correct response is to merge them, not to throw a constraint violation.

**Algorithm when `updates.label` is provided:**

1. Fetch the current node (needed to know its `type` for the collision check).
2. Query for an existing node with `lower(label) = lower(updates.label)` and the same
   `type`, excluding `fact` and excluding `id` itself.
3. If a collision exists → call `mergeEntities(existingId, id)` (existing node is the
   canonical; the node being renamed is the secondary). Return
   `{ node: canonical, merged: true }`.
4. If no collision → call `store.updateNode(id, updates)` as normal. Return
   `{ node: updated, merged: false }`.

**Return type:**
```ts
async updateNode(
  id: string,
  updates: { label?: string; properties?: Record<string, unknown> }
): Promise<{ node: KgNode; merged: boolean }>
```

`merged: true` signals that `node.id` in the result is **different** from the `id` the
caller passed in. Any code holding a reference to the old ID should update it.

**Internal callers are unaffected.** `mergeEntities()` and `storeFact()` call
`store.updateNode()` directly (bypassing `EntityMemory.updateNode()`) and only pass
`properties`, never `label` — the merge-on-collision logic is never triggered for them.

#### 3b. `createEntity()` returns `{ entity, created }`

The return type changes from `KgNode` to `{ entity: KgNode; created: boolean }`.
Internally, `createEntity()` delegates to `store.upsertNode()` instead of
`store.createNode()`.

This is a breaking change to the method signature. All call sites update from:
```ts
const entity = await entityMemory.createEntity({ ... });
```
to:
```ts
const { entity } = await entityMemory.createEntity({ ... });
// or
const { entity, created } = await entityMemory.createEntity({ ... });
```

#### 3c. `contact-service.ts` — apply `role` on conflict

`contact-service.ts` is the only `createEntity` call site that passes non-empty properties
(`{ role: options.role }`). On conflict, the existing node may not have `role` set. The
updated call site:

```ts
const { entity, created } = await this.entityMemory.createEntity({
  type: 'person',
  label: safeName,
  properties: options.role ? { role: options.role } : {},
  source: options.source,
});
if (!created && options.role) {
  const { node } = await this.entityMemory.updateNode(entity.id, {
    properties: { ...entity.properties, role: options.role },
  });
  kgNodeId = node.id;
} else {
  kgNodeId = entity.id;
}
```

Note: `updateNode` now returns `{ node, merged }`. Even for a properties-only update
(no label change), we destructure `node` to get the canonical ID — though `merged` will
always be `false` here since no label is being changed.

Other call sites (`extract-relationships`, `knowledge-meeting-links`, `template-base`)
pass `{}` or constant category properties into race-guarded find-first patterns; no
`updateNode()` follow-up is needed at those sites.

#### 3d. Complete `mergeEntities()` Phase 2

The existing `mergeEntities()` merges scalar properties and facts but leaves a `@TODO`
comment for Phase 2: re-pointing edges and deleting the secondary node. This work
completes Phase 2.

After the existing Phase 1 logic (property merge + fact migration), add:

1. **Re-point edges**: fetch all edges for the secondary node via
   `store.getEdgesForNode(secondaryId)`. For each edge, determine the "other" endpoint
   and call `store.upsertEdge()` with `primaryId` as the new endpoint. `upsertEdge`
   handles the bidirectional uniqueness constraint atomically — if primary already has an
   equivalent edge, it just raises confidence rather than creating a duplicate.

2. **Delete secondary node**: call `store.deleteNode(secondaryId)`. The `ON DELETE
   CASCADE` on `kg_edges` cleans up any secondary edges that were not transferred (e.g.
   self-loops or edges that resolved to a no-op upsert on primary).

3. Remove the `@TODO Phase 2` comment.

### 4. Tests

- `upsertNode` creates a new node when none exists
- `upsertNode` on conflict returns the existing node with updated confidence and
  `last_confirmed_at`, leaves properties untouched, returns `created: false`
- `upsertNode` never lowers confidence (concurrent re-assertion with lower confidence)
- `mergeEntities` Phase 2: secondary's edges are transferred to primary; secondary node
  is deleted; primary's edge count reflects the merged set; duplicate edges (where primary
  already had the same relationship) are not duplicated
- `createEntity` returns `created: true` on first call, `created: false` on second call
  with the same `(label, type)`
- `updateNode` with a label change to a non-conflicting label updates normally,
  returns `{ node: updated, merged: false }`
- `updateNode` with a label change that collides with an existing node of the same type
  merges the two nodes, returns `{ node: canonical, merged: true }` where `node.id` is
  the canonical node's ID (not the original ID passed in)
- `updateNode` with only a properties change (no label) never triggers merge logic

Tests use the in-memory backend (no Postgres required). The migration SQL is tested by
the existing integration test harness that runs migrations against a real Postgres
instance.

## Call-site impact summary

| File | Change |
|---|---|
| `src/memory/knowledge-graph.ts` | Add `upsertNode` to backend interface, `PostgresBackend`, `InMemoryBackend`, and `KnowledgeGraphStore` |
| `src/memory/entity-memory.ts` | Add public `updateNode()` with merge-on-collision; change `createEntity()` return type; complete `mergeEntities()` Phase 2 |
| `src/contacts/contact-service.ts` | Destructure `{ entity, created }` from `createEntity()`; call `updateNode()` if `!created && options.role` |
| `skills/extract-relationships/handler.ts` | Destructure `{ entity }` from `createEntity()` — no other change |
| `skills/knowledge-meeting-links/handler.ts` | Destructure `{ entity }` from `createEntity()` — no other change |
| `skills/_shared/template-base.ts` | Destructure `entity` from `createEntity()` — no other change |
| `src/db/migrations/016_kg_node_uniqueness.sql` | New file |

## Versioning

Patch bump (`0.x.Y`): this is a data-hygiene fix with infrastructure additions, no new
user-facing capability.
