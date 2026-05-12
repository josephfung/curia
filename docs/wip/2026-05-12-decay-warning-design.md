# Decay Warning: Notify Before Archiving Important KG Nodes

**Issue:** #280
**Status:** Design
**Date:** 2026-05-12

---

## Background

When `DreamEngine.runDecayPass()` archives a knowledge graph node, that node
silently disappears from the active graph. For most nodes this is fine — they
decayed naturally and nobody will miss them. But some nodes are important:
they're confidential, or they're connected to many other facts. Silently
archiving these is a loss.

This feature adds a **warn phase** before archiving. Important nodes get flagged,
held back from archiving, and the coordinator surfaces a nudge to the CEO:
"I have this fact on file but it's going stale — is it still accurate?" The CEO
can confirm (reset the decay clock) or dismiss (archive immediately).

---

## Design Decisions

### What makes a node "important"?

A node is important if it meets **either** criterion:

1. **High sensitivity:** `sensitivity` is `confidential` or `restricted`
2. **High connectivity:** edge count is in the top 5th percentile of all
   non-archived nodes, with a floor of 5

The connectivity threshold is **self-tuning** — computed at the start of each
decay pass using PostgreSQL's `percentile_disc(0.95)`. As the graph grows and
edge-count distributions shift, the bar moves automatically. The floor of 5
prevents warnings on trivially-connected nodes in a sparse graph.

Based on production data (2026-05-12, ~4,666 live nodes):
- p95 edge-count lands around 8–10 edges
- 224 nodes are `confidential` or `restricted`
- 144 nodes have 10+ edges
- Overlap between the two sets further reduces the warning pool

### Hold-back window

Warned nodes are held back from archiving for **7 days**. If the CEO doesn't
respond within that window (via the coordinator surfacing the nudge), the next
decay pass archives the node anyway. The data isn't deleted — just archived —
and can be recovered if needed.

### Re-confirmation flow

The coordinator follows the same **proactive check** pattern used for held
messages: during CEO conversations, it calls `decay-warnings-list` to discover
pending warnings, then surfaces them one at a time at natural pauses.

The CEO responds conversationally:
- **Confirm** ("yes, that's still true") -> coordinator calls `memory-confirm`
  with action `confirm` -> resets confidence to 1.0, clears `warned_at`,
  restarts the decay clock
- **Dismiss** ("no, archive it" / "I don't care") -> coordinator calls
  `memory-confirm` with action `dismiss` -> immediately archives the node

No outbound notification (email/Signal) is sent for decay warnings. They're
low-urgency by nature and surface naturally during conversation. If this proves
insufficient (warnings expiring unseen), outbound notifications can be added
later.

---

## Database Changes

### Migration 037: Add `warned_at` to `kg_nodes`

```sql
ALTER TABLE kg_nodes ADD COLUMN warned_at TIMESTAMPTZ;

-- Partial index: only actively-warned, non-archived nodes
CREATE INDEX idx_kg_nodes_warned
  ON kg_nodes (warned_at)
  WHERE warned_at IS NOT NULL AND archived_at IS NULL;
```

No changes to `kg_edges` — warnings apply to nodes only. Edges whose endpoints
are archived continue to be cleaned up by the existing edge archive pass.

### Node state machine

```
normal  -> warned   (warn pass sets warned_at)
warned  -> normal   (memory-confirm: confirm -> clears warned_at, resets confidence to 1.0)
warned  -> archived (memory-confirm: dismiss, OR hold-back window expires)
```

"Confirmed" returns the node to normal — it's not a separate persistent state.

---

## DreamEngine Changes

### Constructor

The `_bus` parameter drops the underscore prefix and is stored on the instance
as `this.bus`. This is the only constructor change.

### DecayConfig additions

```typescript
edgeCountPercentile: number;  // default 0.95 (top 5%)
edgeCountFloor: number;       // default 5
warnHoldBackDays: number;     // default 7
```

### Modified pass ordering in `_runDecayPassOnClient()`

1. **Pass 1a–1d** — Decay confidence on slow_decay and fast_decay nodes and
   edges (unchanged)
2. **Pass 1.5 (new): Warn pass**
   - Compute the edge-count threshold:
     ```sql
     SELECT GREATEST(
       (SELECT percentile_disc($1) WITHIN GROUP (ORDER BY edge_count)
        FROM (
          SELECT n.id, COUNT(e.id) AS edge_count
          FROM kg_nodes n
          LEFT JOIN kg_edges e ON e.source_node_id = n.id OR e.target_node_id = n.id
          WHERE n.archived_at IS NULL
          GROUP BY n.id
        ) sub),
       $2
     ) AS threshold
     ```
     Parameters: `[edgeCountPercentile, edgeCountFloor]`
   - Find archive-candidate nodes that are "important":
     - `confidence <= archiveThreshold`
     - `decay_class != 'permanent'`
     - `archived_at IS NULL`
     - `warned_at IS NULL` (not already warned)
     - AND (`sensitivity IN ('confidential', 'restricted')` OR edge_count >= threshold)
   - Set `warned_at = NOW()` on matched nodes
   - For each warned node, emit `memory.decay_warning` bus event (for audit)
3. **Pass 2a (new): Archive expired warnings** — archive nodes where
   `warned_at IS NOT NULL AND warned_at <= NOW() - interval '$warnHoldBackDays days'`
   (hold-back expired, CEO didn't respond). Sets `archived_at = NOW()` and
   clears `warned_at`. Row count = `nodesExpired`.
4. **Pass 2b: Archive regular nodes** — the existing archive pass, with an
   added exclusion: `AND warned_at IS NULL`. Nodes with active (non-expired)
   warnings are held back. Expired warnings were already handled in 2a.
   Row count = `nodesArchived` (existing field).
5. **Pass 3: Archive edges** (unchanged)

### DecayPassResult additions

```typescript
nodesWarned: number;   // nodes newly flagged in this pass
nodesExpired: number;  // warned nodes archived due to expired hold-back
```

---

## Bus Event

### `memory.decay_warning`

Added to `src/bus/events.ts`:

```typescript
// Source layer: 'system' (DreamEngine is system-layer infrastructure)
interface MemoryDecayWarningPayload {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  confidence: number;
  sensitivity: Sensitivity;
  edgeCount: number;
  reason: 'high_sensitivity' | 'high_connectivity' | 'both';
}
```

The `reason` field tells the coordinator and audit log why the node was flagged,
so the nudge to the CEO can be specific: "this is flagged because it's
confidential" vs "this is flagged because it's connected to 25 other facts."

Layer permission: `system` can publish `memory.decay_warning`. The event is
consumed by the audit logger (via the existing write-ahead hook) and can be
subscribed to by the `dispatch` layer if needed in the future.

---

## Skills

### `decay-warnings-list`

**Purpose:** Read-only query of nodes in the "warned" state.

**Manifest (`skills/decay-warnings-list/skill.json`):**
```json
{
  "name": "decay-warnings-list",
  "description": "List knowledge graph nodes flagged for re-confirmation before archival",
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

**Handler:** Queries `kg_nodes` where `warned_at IS NOT NULL AND archived_at IS NULL`,
joined to `kg_edges` for edge count. Returns:

```typescript
{
  warnings: Array<{
    nodeId: string;
    nodeType: NodeType;
    label: string;
    confidence: number;
    sensitivity: Sensitivity;
    edgeCount: number;
    reason: 'high_sensitivity' | 'high_connectivity' | 'both';
    warnedAt: string;          // ISO timestamp (local via toLocalIso)
    daysRemaining: number;     // days until auto-archive
  }>;
  count: number;
}
```

Sorted by `warned_at ASC` (oldest first), matching the coordinator's instruction
to surface the oldest warning first.

### `memory-confirm`

**Purpose:** CEO confirms or dismisses a warned node.

**Manifest (`skills/memory-confirm/skill.json`):**
```json
{
  "name": "memory-confirm",
  "description": "Confirm or dismiss a knowledge graph node flagged by decay warning",
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

**Handler logic:**

- **`action: "confirm"`** — `UPDATE kg_nodes SET last_confirmed_at = NOW(), confidence = 1.0, warned_at = NULL WHERE id = $1 AND warned_at IS NOT NULL AND archived_at IS NULL`.
  Restarts the decay clock. The node is fresh again.
- **`action: "dismiss"`** — `UPDATE kg_nodes SET archived_at = NOW(), warned_at = NULL WHERE id = $1 AND warned_at IS NOT NULL AND archived_at IS NULL`.
  Immediate archive per CEO's decision.
- Both actions clear `warned_at` — the node leaves the "warned" state either way.
- Returns `{ success: false }` if the node isn't in a warned state (already
  archived, already confirmed, or doesn't exist).

---

## Coordinator Prompt Update

Add to `agents/coordinator.yaml` alongside the existing held-messages guidance:

```yaml
When talking to the CEO:
  - After checking held messages, also call decay-warnings-list to check
    for knowledge graph nodes flagged for re-confirmation.
  - If there are warnings, briefly describe the node and why it was flagged:
    "I have [label] on file but it's going stale — is it still accurate?"
  - Surface the oldest warning first, one at a time (don't dump a list).
  - If the CEO confirms, call memory-confirm with action "confirm".
  - If the CEO says to archive/dismiss/doesn't care, call memory-confirm
    with action "dismiss".
  - Don't bring up decay warnings if the CEO is in the middle of something
    urgent — wait for a natural pause, same as held messages.
```

Add `decay-warnings-list` and `memory-confirm` to the coordinator's
`pinned_skills` list.

---

## Testing

### DreamEngine unit tests (`dream-engine.test.ts`)

- Warn pass flags high-sensitivity nodes at/below archive threshold
- Warn pass flags high-edge-count nodes (above computed percentile, above floor)
- Warn pass respects the edge-count floor (doesn't warn below floor even if
  percentile is lower)
- Already-warned nodes are not re-warned (idempotency)
- Warned nodes within hold-back window are excluded from archive pass
- Expired warnings (>7 days) are archived by the archive pass
- `memory.decay_warning` event is emitted for each newly warned node
- `DecayPassResult` includes correct `nodesWarned` and `nodesExpired` counts
- Permanent nodes are never warned (they can't be archived)

### Skill handler tests

- `memory-confirm` with action `confirm` resets `last_confirmed_at`,
  sets `confidence = 1.0`, clears `warned_at`
- `memory-confirm` with action `dismiss` sets `archived_at`, clears `warned_at`
- `memory-confirm` returns `{ success: false }` for non-warned nodes
- `decay-warnings-list` returns only warned, non-archived nodes
- `decay-warnings-list` computes `daysRemaining` correctly
- `decay-warnings-list` returns results sorted by `warned_at ASC`

---

## Out of Scope

- **Outbound notifications** for decay warnings (email/Signal). Can be added
  later if warnings expire unseen.
- **Batch confirm/dismiss** — the coordinator surfaces one at a time. Batch
  operations can be added if the warning volume becomes unwieldy.
- **Edge warnings** — only nodes are warned. Edges are cleaned up transitively
  when their endpoints are archived.
- **Dashboard UI** for reviewing warnings — the coordinator handles this
  conversationally for now.
