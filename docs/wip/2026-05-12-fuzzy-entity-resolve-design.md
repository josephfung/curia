# Fuzzy Entity Resolution for Non-Contact KG Nodes

**Issue:** [#467](https://github.com/josephfung/curia/issues/467)
**Date:** 2026-05-12

## Problem

`resolveOrCreate()` resolves non-contact entities by exact case-insensitive label
match only (`WHERE lower(label) = lower($1)`). When the CEO refers to the same
entity by slightly different names — "Darlise", "Darlise Restaurant", "the
Darlise place" — each variant silently creates a separate KG node. Facts fragment
across the graph, and `memory-query` recall degrades over time.

Contacts don't have this problem because the coordinator resolves them via
`contact-lookup → kg_node_id` before calling `memory-store`, bypassing label
matching entirely.

## Solution

Three layered changes to `resolveOrCreate()` and its surroundings:

1. **Migration: `aliases` column** — a `TEXT[]` array on `kg_nodes` that stores
   confirmed name variants, capped at 10 per entity.
2. **Embedding fallback** — when exact match (label + aliases) fails, embed the
   input and vector-search entity nodes using a two-tier similarity threshold.
3. **Alias learning** — when the coordinator confirms a disambiguation, store the
   variant as an alias so future lookups resolve instantly via exact match.

## Resolution Flow (New)

```
Input label
    │
    ├─ Exact match on lower(label) OR lower($1) = ANY(aliases)?
    │   └─ yes → existing found/ambiguous logic (unchanged)
    │
    ├─ no → embed the label, vector search non-fact non-archived entity nodes
    │   │
    │   ├─ best candidate ≥ 0.90 cosine similarity → { kind: 'found', node }
    │   ├─ any candidates 0.75–0.90 → { kind: 'ambiguous', candidates }
    │   └─ nothing ≥ 0.75 → create new entity (reuse the computed embedding)
    │
    └─ done
```

### Exact-match phase (step 1)

`findNodesByLabel()` gains alias awareness. The SQL becomes:

```sql
SELECT * FROM kg_nodes
WHERE (lower(label) = lower($1) OR lower($1) = ANY(aliases))
  AND archived_at IS NULL
```

The `aliases` column stores pre-lowercased strings, so the `ANY(aliases)` check
compares `lower(input)` against stored values directly. A GIN index on the array
supports efficient containment queries.

This phase is unchanged in semantics — it returns all matching nodes, and the
existing 0/1/2+ branching in `resolveOrCreate()` handles the result the same way.

### Embedding fallback (step 2)

When exact match returns 0 results, `resolveOrCreate()`:

1. Embeds the input label via `embeddingService.embed(label)`.
2. Runs a vector search against non-fact, non-archived entity nodes using the
   existing pgvector HNSW index.
3. Applies the two-tier threshold to partition results:
   - **≥ 0.90** (auto-resolve threshold): high confidence that this is the same
     entity. Returns `{ kind: 'found', node }` for the best match.
   - **0.75–0.90** (ambiguity zone): plausible but uncertain. Returns
     `{ kind: 'ambiguous', candidates }` with ranked results.
   - **< 0.75**: no plausible match. Falls through to entity creation, reusing
     the embedding vector already computed (avoids a redundant API call).

The vector search filters to `type != 'fact'` and `archived_at IS NULL` but does
**not** filter by the caller's type hint. This is consistent with the existing
single-match behavior where a lone label match returns 'found' even when the type
differs (see issue #474). The type hint participates only as a tiebreaker when
multiple candidates exceed the auto-resolve threshold, consistent with the existing
2+ match logic.

### Alias learning (step 3)

When `memory-store` receives an `ambiguous` result and the coordinator confirms
which entity the CEO meant, the handler calls:

```typescript
await ctx.entityMemory.addAlias(confirmedNodeId, originalInputLabel);
```

`addAlias()`:
- Lowercases the alias.
- Checks the current alias count; rejects if >= 10 (logs a warning, does not
  throw — the fact storage still proceeds, we just don't learn the alias).
- Appends to the `aliases` array on the node via
  `UPDATE kg_nodes SET aliases = array_append(aliases, $2) WHERE id = $1`.

On subsequent calls with the same variant, exact match finds it via the alias
in step 1 — no embedding call needed.

### Auto-resolve alias learning

When the embedding fallback auto-resolves (≥ 0.90), the system also stores the
input label as an alias on the matched node. This prevents the same high-confidence
match from requiring an embedding call on every future occurrence.

## Thresholds

| Constant | Value | Rationale |
|----------|-------|-----------|
| `FUZZY_RESOLVE_THRESHOLD` | 0.90 | Entity labels are short phrases; 0.90 is high enough to avoid false matches but lower than the 0.92 fact dedup threshold (fact labels like "location: Toronto" carry more semantic signal than bare entity names) |
| `FUZZY_AMBIGUITY_FLOOR` | 0.75 | Below this, names are too different to be plausible variants of the same entity |
| `MAX_ALIASES_PER_ENTITY` | 10 | Guardrail against degenerate alias accumulation; real entities rarely have more than 3-4 name variants |

These are defined as named constants in `entity-memory.ts`, easy to tune later.

## Performance

The embedding API call in the fallback path is not new overhead — `upsertNode()`
already calls `embeddingService.embed(label)` on every entity creation. The
fallback simply moves this call earlier in the flow (before the create/match
decision) and adds one indexed vector search query against the HNSW index.

On the happy path (exact match on label or alias), there is zero added cost —
no embedding call, no vector search.

| Scenario | Before | After |
|----------|--------|-------|
| Exact label match | 1 DB query | 1 DB query (same, now includes alias check) |
| Alias match (learned) | N/A (would create duplicate) | 1 DB query (alias hit in exact-match phase) |
| Fuzzy match (first time) | 1 DB query + 1 embed (creates duplicate) | 1 DB query + 1 embed + 1 vector search (correct match) |
| No match → create | 1 DB query + 1 embed | 1 DB query + 1 embed + 1 vector search (confirms no near-match) |

## Migration

Migration `037_add_kg_node_aliases.sql`:

```sql
ALTER TABLE kg_nodes ADD COLUMN aliases TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_kg_nodes_aliases ON kg_nodes USING GIN (aliases);
```

The `aliases` array stores pre-lowercased strings. The GIN index supports
`lower($1) = ANY(aliases)` containment queries efficiently.

## Scope

### In scope (this issue)

- Migration adding `aliases TEXT[]` column + GIN index
- `findNodesByLabel()` gains alias awareness in both Postgres and in-memory backends
- `resolveOrCreate()` gains embedding fallback with two-tier threshold
- `addAlias()` method on `EntityMemory` with cap enforcement
- `memory-store` handler calls `addAlias()` after disambiguation confirmation
  and after auto-resolve
- Unit tests for all new behavior
- Integration test for the full resolve → disambiguate → alias → re-resolve cycle

### Out of scope (follow-up issues)

- `updateNode()` label-collision check using aliases
- `memory-query` semantic search surfacing alias matches
- `mergeEntities()` consolidating aliases from both nodes
- Other callers of `findNodesByLabel()` (e.g. extract-facts)
- Backfill: detecting and merging existing duplicate nodes in production
