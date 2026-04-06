# Relationship Management Skills — Design

**Date:** 2026-04-05
**Status:** Approved, pending implementation

## Overview

Two new skills — `query-relationships` and `delete-relationship` — give Nathan the ability to
read and correct the knowledge graph's entity-to-entity edges via natural language. A supporting
migration enforces edge uniqueness at the database level.

The existing `extract-relationships` skill (PR #155) handles *writing* edges automatically from
conversation text. These two skills complete the CRUD surface for relationship edges.

---

## 1. Migration 014 — Edge Uniqueness Constraint

**Problem:** `kg_edges` has no unique constraint. `upsertEdge()` prevents duplicates via a
pre-query check, but concurrent writes can race past it and create duplicate rows.

**Fix:** Add a bidirectional unique index using Postgres expression columns, treating
`(source, target, type)` and `(target, source, type)` as the same edge.

```sql
-- Dedup existing rows: for each duplicate group, keep highest confidence
-- (ties broken by most recent last_confirmed_at), delete the rest.
DELETE FROM kg_edges
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY LEAST(source_node_id::text, target_node_id::text),
                     GREATEST(source_node_id::text, target_node_id::text),
                     type
        ORDER BY confidence DESC, last_confirmed_at DESC
      ) AS rn
    FROM kg_edges
  ) ranked
  WHERE rn > 1
);

-- Bidirectional unique index
CREATE UNIQUE INDEX idx_kg_edges_unique
  ON kg_edges (
    LEAST(source_node_id::text, target_node_id::text),
    GREATEST(source_node_id::text, target_node_id::text),
    type
  );
```

**`upsertEdge` update:** Replace the current pre-query + insert pattern with
`INSERT ... ON CONFLICT (LEAST(source_node_id::text, target_node_id::text), GREATEST(source_node_id::text, target_node_id::text), type) DO UPDATE SET ...`.
Expression indexes require the full expression in the `ON CONFLICT` clause — not the index
name. This is atomic and race-condition-safe. The `GREATEST` confidence rule (never lower) is
preserved in the `DO UPDATE` clause.

---

## 2. EntityMemory Additions

Two new public methods added to `src/memory/entity-memory.ts`:

### `deleteEdge(id: string): Promise<void>`

Thin delegation to `store.deleteEdge(id)`. Logs the deletion (edge ID, timestamp) before
executing for audit purposes. Hard delete — no soft-delete; cascades per the FK on `kg_nodes`.

### `findEdges(nodeId, opts?): Promise<EdgeResult[]>`

```typescript
interface EdgeResult {
  edge: KgEdge;
  node: KgNode;            // the connected node (the other end)
  direction: 'inbound' | 'outbound';
}

findEdges(
  nodeId: string,
  opts?: { type?: EdgeType; direction?: 'inbound' | 'outbound' | 'both' }
): Promise<EdgeResult[]>
```

Builds on the existing `getEdgesForNode()` (already queries both directions) and adds:
- Type filtering (applied in-process after fetch)
- Direction filtering
- Resolves the connected node for each edge (one node fetch per edge, or a batched query)
- Filters out edges to `fact`-type nodes (those are facts, not entity relationships)

---

## 3. `query-relationships` Skill

**Purpose:** Let Nathan answer questions like "who is Joseph married to?" or "show me all
relationships for Xiaopu" by querying the knowledge graph directly.

### Manifest

```json
{
  "name": "query-relationships",
  "description": "Query entity-to-entity relationships from the knowledge graph. Resolves entities by name. Returns all relationships, or filtered by edge type.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "infrastructure": true,
  "inputs": {
    "entity": "string — the name/label of the entity to query (e.g. 'Joseph Fung')",
    "edge_type": "string? — optional edge type filter (e.g. 'spouse', 'reports_to')"
  },
  "outputs": {
    "relationships": "array of {edge_id, subject, predicate, object, direction, confidence, last_confirmed_at}",
    "count": "number",
    "ambiguous": "boolean — true when multiple nodes matched the entity name",
    "candidates": "array of {id, label, type} — populated when ambiguous is true"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

### Handler Logic

1. Validate `edge_type` if provided — must be a known `EdgeType`; return error if not
2. `findEntities(entity)` — case-insensitive label search
3. **Zero matches** → `{ success: true, data: { relationships: [], count: 0 } }`
4. **Multiple matches** → `{ success: true, data: { ambiguous: true, candidates: [{id, label, type}] } }`
   — Nathan surfaces this to the user ("I found multiple people named X, which one?")
5. **Single match** → `findEdges(nodeId, { type, direction: 'both' })`
6. Map each `EdgeResult` to:
   ```typescript
   {
     edge_id: edge.id,
     subject: direction === 'outbound' ? entity : node.label,
     predicate: edge.type,
     object: direction === 'outbound' ? node.label : entity,
     direction,
     confidence: edge.temporal.confidence,
     last_confirmed_at: edge.temporal.lastConfirmedAt,
   }
   ```
7. Return `{ relationships, count: relationships.length }`

### Coordinator Wiring

- Add `query-relationships` to `pinned_skills` in `coordinator.yaml`
- No additional system prompt instruction needed — the skill description is self-explanatory

---

## 4. `delete-relationship` Skill

**Purpose:** Let Nathan correct the knowledge graph when a relationship is wrong or stale.
Triggered by explicit user instruction ("that relationship is wrong", "remove the fact that...").

### Manifest

```json
{
  "name": "delete-relationship",
  "description": "Delete an entity-to-entity relationship from the knowledge graph. Identified by subject name, predicate (edge type), and object name. Permanent — cannot be undone.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "infrastructure": true,
  "inputs": {
    "subject": "string — name/label of the source entity (e.g. 'Joseph Fung')",
    "predicate": "string — the edge type to delete (e.g. 'spouse', 'reports_to')",
    "object": "string — name/label of the target entity (e.g. 'Xiaopu Fung')"
  },
  "outputs": {
    "deleted": "boolean — true if an edge was found and removed",
    "edge_id": "string? — the ID of the deleted edge (populated when deleted is true)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

### Handler Logic

1. Validate `predicate` is a known `EdgeType` — return error if not
2. `findEntities(subject)` — zero or ambiguous → return disambiguation response (same shape as
   `query-relationships` ambiguous case)
3. `findEntities(object)` — same
4. `findEdges(subjectNodeId, { type: predicate, direction: 'both' })` — filter to edges where
   the connected node ID matches `objectNodeId`
5. **No match** → `{ success: true, data: { deleted: false } }` — idempotent
6. **Match** → log (subject label, predicate, object label, edge ID, confidence) then
   `deleteEdge(edge.id)` → `{ success: true, data: { deleted: true, edge_id: edge.id } }`

### Coordinator Wiring

- Add `delete-relationship` to `pinned_skills`
- Add to coordinator system prompt (alongside the `extract-relationships` block):

  > Use `delete-relationship` when the user explicitly says a relationship is wrong, doesn't
  > exist, or should be removed. Always confirm with the user what you deleted.

---

## 5. Testing

### `query-relationships`
- Zero matches → empty result
- Single match, no type filter → all edges returned
- Single match, type filter → only matching edges returned
- Multiple matches → `ambiguous: true` with candidates
- Unknown `edge_type` → error response
- Direction is correctly labeled (inbound vs outbound)

### `delete-relationship`
- Nonexistent edge → `deleted: false` (idempotent)
- Valid triple → edge removed, `deleted: true`, `edge_id` returned
- Ambiguous subject or object → disambiguation response
- Unknown `predicate` → error response
- Integration: deleted edge does not appear in subsequent `query-relationships` call

### Migration 014
- Dedup: existing duplicates are collapsed (highest confidence kept)
- Unique constraint: subsequent duplicate insert raises conflict
- `upsertEdge` ON CONFLICT path: re-assertion updates `last_confirmed_at`, raises confidence

---

## 6. Files to Create / Modify

| File | Action |
|------|--------|
| `src/db/migrations/014_kg_edge_uniqueness.sql` | Create — migration |
| `src/memory/entity-memory.ts` | Modify — add `deleteEdge()`, `findEdges()` |
| `skills/query-relationships/skill.json` | Create |
| `skills/query-relationships/handler.ts` | Create |
| `skills/query-relationships/handler.test.ts` | Create |
| `skills/delete-relationship/skill.json` | Create |
| `skills/delete-relationship/handler.ts` | Create |
| `skills/delete-relationship/handler.test.ts` | Create |
| `agents/coordinator.yaml` | Modify — pinned_skills + system prompt |
| `CHANGELOG.md` | Modify |
| `package.json` | Modify — minor version bump (new skills) |
