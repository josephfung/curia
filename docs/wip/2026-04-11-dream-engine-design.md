# Dream Engine — Design

**Issue:** josephfung/curia#27
**Date:** 2026-04-11
**Status:** Approved

---

## Overview

The Dream Engine is a background maintenance system that runs periodic passes on the knowledge graph when the system is not actively serving a conversation. The name reflects the neuroscience analogy: sleep is when the brain consolidates short-term experiences into long-term memory, prunes weak connections, and resolves conflicts.

This spec covers the first pass: **memory decay**. Future passes (contradiction resolution, working-memory synthesis, etc.) will be added as sibling passes under the same engine. See [Future Passes](#future-passes) below.

---

## Design Decisions

### Soft-delete, not hard-delete

When a node's confidence falls below the archive threshold, it is soft-deleted: `archived_at` is set to the current timestamp. The row remains in the database for audit purposes and can be restored if the fact is later re-confirmed.

Hard delete was rejected because it permanently destroys information that may still be useful for audit, debugging, or re-confirmation flows.

### Edges follow their endpoints

When a node is archived, any edge where it is the source or target is also archived in the same pass. A dangling edge pointing to an archived node has no queryable meaning and would corrupt traversal results.

Edges also decay and archive independently based on their own confidence — an edge between two active nodes can still decay to the point of archiving.

### All read paths filter archived rows

`WHERE archived_at IS NULL` is added to every query that reads `kg_nodes` or `kg_edges`:
- `semanticSearch`
- `traverse` (both the recursive CTE and the node join)
- `findNodesByType`, `findNodesByLabel`, `getNode`
- `getEdgesForNode`

Without this, archived facts would continue to surface in agent context.

### Exponential confidence decay

Confidence decays using a half-life model:

```text
new_confidence = current_confidence × 0.5^(days_since_last_confirmed / half_life_days)
```

This means confidence halves after one half-life, quarters after two, etc. `permanent` nodes are never touched by the decay pass.

Half-lives are configurable per decay class (see [Configuration](#configuration)).

### EventBus injected from day one

`DreamEngine` accepts `EventBus` as a required constructor argument even though the first implementation does not publish events. This reserves the wiring for the future decay warning pass (josephfung/curia#280), which will emit `memory.decay_warning` before archiving important nodes, without requiring a signature change.

### Single engine, per-pass intervals (Approach B)

Each pass runs on its own configurable interval. This avoids forcing all maintenance work onto a single cadence while keeping all background maintenance under one roof. Future passes slot in as sibling config keys under `dreaming`.

---

## Configuration

New block in `config/default.yaml`:

```yaml
dreaming:
  decay:
    intervalMs: 86400000     # how often the decay pass runs (default: daily)
    archiveThreshold: 0.05   # confidence at or below this → archived
    halfLifeDays:
      permanent: null        # never decays
      slow_decay: 180        # reliable for months/years; halves every 6 months
      fast_decay: 21         # unreliable after weeks; halves every 3 weeks
```

---

## Database Migration

Add `archived_at TIMESTAMPTZ` (nullable, default NULL) to both `kg_nodes` and `kg_edges`.

Partial indexes for efficient filtering:

```sql
ALTER TABLE kg_nodes ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE kg_edges ADD COLUMN archived_at TIMESTAMPTZ;

CREATE INDEX idx_kg_nodes_archived_at ON kg_nodes (archived_at) WHERE archived_at IS NULL;
CREATE INDEX idx_kg_edges_archived_at ON kg_edges (archived_at) WHERE archived_at IS NULL;
```

---

## `DreamEngine` Class

**File:** `src/memory/dream-engine.ts`

```typescript
class DreamEngine {
  constructor(pool: Pool, bus: EventBus, logger: Logger, config: DreamEngineConfig)
  
  // Run the full decay pass: decay → archive nodes → archive edges
  async runDecayPass(): Promise<DecayPassResult>
  
  // Start the recurring interval timer
  start(): void
  
  // Stop the timer (for clean shutdown)
  stop(): void
}
```

### `runDecayPass()` — three SQL passes in order

**Pass 1 — Confidence decay**

For all non-archived `slow_decay` and `fast_decay` nodes and edges, reduce confidence:

```sql
UPDATE kg_nodes
SET confidence = confidence * power(0.5, 
    EXTRACT(EPOCH FROM (now() - last_confirmed_at)) / 86400 / $half_life_days)
WHERE archived_at IS NULL
  AND decay_class = $decay_class
  AND confidence > $archive_threshold
```

Run once for `slow_decay` (180-day half-life) and once for `fast_decay` (21-day half-life). `permanent` nodes are skipped entirely.

The `confidence > $archive_threshold` guard means nodes already below the threshold are not decayed further — they are simply archived in Pass 2. This avoids unnecessary writes on already-condemned rows.

Same pass runs on `kg_edges`.

**Pass 2 — Archive nodes**

```sql
UPDATE kg_nodes
SET archived_at = now()
WHERE archived_at IS NULL
  AND decay_class != 'permanent'
  AND confidence <= $archive_threshold
```

**Pass 3 — Archive edges**

Archive edges whose own confidence is at or below threshold, OR whose source or target node was just archived:

```sql
UPDATE kg_edges
SET archived_at = now()
WHERE archived_at IS NULL
  AND (
    confidence <= $archive_threshold
    OR source_node_id IN (SELECT id FROM kg_nodes WHERE archived_at IS NOT NULL)
    OR target_node_id IN (SELECT id FROM kg_nodes WHERE archived_at IS NOT NULL)
  )
```

### `DecayPassResult`

```typescript
interface DecayPassResult {
  nodesDecayed: number;    // rows updated in pass 1 (nodes)
  edgesDecayed: number;    // rows updated in pass 1 (edges)
  nodesArchived: number;   // rows updated in pass 2
  edgesArchived: number;   // rows updated in pass 3
  durationMs: number;
}
```

Result is logged at `info` level after each run.

---

## Wiring

In `Scheduler.start()`, after the job poll and watchdog intervals are registered:

```typescript
const dreamEngine = new DreamEngine(pool, bus, logger, config.dreaming);
dreamEngine.start();
```

Startup logs the decay interval so operators can verify configuration.

---

## Future Passes

The following passes are planned but not in scope for this spec. They will be added as sibling methods on `DreamEngine` with their own config keys under `dreaming`:

| Pass | Config key | Trigger | Issue |
|---|---|---|---|
| Decay warning | `dreaming.decayWarning` | Before archiving important nodes | josephfung/curia#280 |
| Contradiction resolution | `dreaming.contradictions` | Periodic | TBD |
| Working-memory synthesis | `dreaming.synthesis` | Post-conversation checkpoint | TBD |

---

## Testing

### Unit tests (`src/memory/dream-engine.test.ts`)

- Decay pass reduces confidence by the correct factor for `slow_decay` and `fast_decay` nodes at known ages
- `permanent` nodes are never touched
- Nodes at or below `archiveThreshold` after decay are archived
- Edges with archived endpoints are archived in pass 3
- Edges with their own confidence at threshold are archived independently
- `DecayPassResult` counts are accurate
- Config with `permanent: null` half-life does not produce a SQL call for permanent nodes

### Integration tests (real Postgres)

- Seed nodes with varied `last_confirmed_at` and decay classes; run `runDecayPass()`; assert final confidence values and `archived_at` state
- Verify archived nodes do not appear in `semanticSearch`, `traverse`, `findNodesByType`, or `findNodesByLabel`
- Verify archived edges do not appear in `getEdgesForNode` or `traverse`
- Verify a re-confirmed node (manually update `last_confirmed_at` + raise confidence) survives subsequent decay runs
