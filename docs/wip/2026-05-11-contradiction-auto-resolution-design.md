# Design: Contradiction Auto-Resolution in Memory Validation

**Date:** 2026-05-11
**Issue:** josephfung/curia#26
**Spec:** docs/specs/01-memory-system.md lines 118–123
**Milestone:** v0.27

---

## Background

The memory validation pipeline detects contradicting facts (same entity, same `attribute` property, different label). Spec 01 defines three resolution paths based on relative confidence:

- Existing fact has **higher** confidence → reject the incoming write
- Existing fact has **lower** confidence → update the existing fact, preserve old value for audit
- Facts have **equal** confidence → flag for human review

Phase 6 implemented only the equal-confidence case. All three paths currently escalate to the user regardless of relative confidence.

This design implements the two missing auto-resolution paths.

---

## Architecture

### Type changes

Two new variants are added to `ValidationResult` (`src/memory/types.ts`):

```typescript
| { action: 'auto_rejected'; existingNodeId: string; reason: string }
| {
    action: 'auto_resolved';
    existingNodeId: string;
    newLabel: string;
    newProperties: Record<string, unknown>; // includes previous_values array
    newConfidence: number;
    reason: string;
  }
```

`StoreFactResult.action` in `entity-memory.ts` gains `'auto_rejected'` and `'auto_resolved'`.

Semantics:
- `auto_rejected` → `stored: false` (write dropped; nothing persisted)
- `auto_resolved` → `stored: true` (existing node updated; counts as a write for rate-limit purposes)

### `validateContradiction` — three branches

`validateContradiction` already requires `confidence: number` (not optional). `storeFact` passes `options.confidence ?? 0.7` before calling it, so the comparison always operates on two concrete numbers — never `undefined` vs a real value.

When a contradicting fact is detected (same entity, same `attribute`, different label), the validator compares `targetNode.temporal.confidence` against `options.confidence`:

```
existing.temporal.confidence  vs  options.confidence

  existing > incoming  →  auto_rejected
  existing < incoming  →  auto_resolved
  existing === incoming →  conflict (human review — unchanged)
```

**`auto_rejected` result:**
```typescript
{
  action: 'auto_rejected',
  existingNodeId: targetNode.id,
  reason: `Existing fact "${existing.label}" (${existingConf}) has higher confidence than incoming "${options.label}" (${incomingConf}) — write rejected`,
}
```

**`auto_resolved` result:**

The validator builds the `previous_values` audit trail before returning. It is an **array** so that a fact superseded multiple times retains the full replacement chain. If `targetNode.properties.previous_values` already exists and is an array, the new entry is appended; otherwise a new single-entry array is started.

```typescript
const previousValuesHistory = Array.isArray(targetNode.properties.previous_values)
  ? targetNode.properties.previous_values
  : [];

{
  action: 'auto_resolved',
  existingNodeId: targetNode.id,
  newLabel: options.label,
  newConfidence: options.confidence,
  newProperties: {
    ...targetNode.properties,
    ...(options.properties ?? {}),
    previous_values: [
      ...previousValuesHistory,
      {
        label: targetNode.label,
        confidence: existingConfidence,
        replacedAt: new Date().toISOString(),
        replacedBy: options.source,
      },
    ],
  },
  reason: `Incoming fact "${options.label}" (${incomingConf}) supersedes existing "${existing.label}" (${existingConf}) — previous value preserved in properties.previous_values`,
}
```

### `KnowledgeGraphStore.updateNode()` — confidence support

The existing update signature only accepts `label`, `properties`, and `sensitivity`. A `confidence?: number` field is added so the auto-resolve path can raise the stored confidence to match the incoming fact:

```typescript
async updateNode(
  id: string,
  updates: {
    label?: string;
    properties?: Record<string, unknown>;
    sensitivity?: Sensitivity;
    confidence?: number;   // ← new
  },
): Promise<KgNode>
```

In the implementation, `temporal.confidence` is set to `updates.confidence ?? existing.temporal.confidence` when assembling the updated node. The Postgres backend's `updateNode(id, fullNode)` already accepts a full node, so no schema migration is needed.

### `storeFact` — new cases

**`auto_rejected`:**
- Log at `info` (expected semantic outcome, not an error)
- Return `{ stored: false, action: 'auto_rejected', conflict: reason, existingNodeId }`
- No `recordWrite` call

**`auto_resolved`:**
1. Call `store.updateNode(existingNodeId, { label: newLabel, properties: newProperties, confidence: newConfidence })`
2. Call `validator.recordWrite(options.source)`
3. Apply the same sensitivity ratchet used in the `update` case (merged content can only increase sensitivity, never decrease)
4. Return `{ stored: true, action: 'auto_resolved', nodeId: existingNodeId, sensitivity, sensitivityFallback? }`

### Skill handler: `memory-store`

The handler branches on `result.stored` first, then checks specific action codes for `stored: false` results.

- **`auto_resolved`** (`stored: true`): falls into the existing `if (result.stored)` branch, which already passes `result.action` through in the response data. No code change needed in this branch — the LLM sees `{ stored: true, action: 'auto_resolved', node_id, sensitivity }`.
- **`auto_rejected`** (`stored: false`): falls to the `switch` statement. New case added:
  ```
  log info: "fact auto-rejected — existing has higher confidence"
  return { stored: false, action: 'auto_rejected', reason, existing_node_id }
  ```
  The exhaustive `default` continues to guard against unhandled future variants.

### Skill handler: `extract-facts`

The loop treats results differently depending on whether they represent infra failures or expected semantic outcomes. The new actions fit into the existing categories:

- **`auto_resolved`** — counts as a stored fact (same as `created`/`updated`); log at `info`
- **`auto_rejected`** — expected semantic outcome, not an infra failure; log at `warn` with reason; do not count toward the failed tally and do not trigger the early-exit path that `rate_limited` uses

---

## Data shape: `previous_values`

Each entry in the `previous_values` array on a superseded fact node has this shape:

```typescript
{
  label: string;          // the old fact label before replacement
  confidence: number;     // the old confidence score
  replacedAt: string;     // ISO 8601 timestamp
  replacedBy: string;     // provenance source string, e.g. "agent:coordinator/task:abc/channel:email"
}
```

Example after two supersessions:
```json
"previous_values": [
  {
    "label": "Bob lives in Kitchener",
    "confidence": 0.6,
    "replacedAt": "2026-03-01T10:00:00.000Z",
    "replacedBy": "agent:coordinator/task:t1/channel:email"
  },
  {
    "label": "Bob lives in Toronto",
    "confidence": 0.7,
    "replacedAt": "2026-04-15T14:30:00.000Z",
    "replacedBy": "agent:coordinator/task:t2/channel:signal"
  }
]
```

The current live fact label would then be whatever superseded the Toronto entry.

---

## Tests

### `tests/unit/memory/validation.test.ts`

New cases added to the `'contradiction detection'` describe block:

- Higher-confidence existing → `auto_rejected`; reason includes both labels and confidence values
- Lower-confidence existing → `auto_resolved`; `newLabel`, `newConfidence`, and `previous_values[0]` correct
- Lower-confidence existing with pre-existing `previous_values` array → array has two entries (chain test)
- Equal confidence still returns `conflict` (regression guard — unchanged behavior)

### Integration test: `storeFact` with auto-resolution

Added to whichever `entity-memory.*.test.ts` file covers `storeFact` mutations:

- `storeFact` with higher-confidence existing → `{ stored: false, action: 'auto_rejected' }`; store unchanged
- `storeFact` with lower-confidence existing → `{ stored: true, action: 'auto_resolved' }`; node label + confidence updated; `previous_values` populated

### `skills/memory-store/handler.test.ts`

Two new cases following the mock-injection pattern:

- Mock returns `auto_rejected` → handler returns `{ stored: false, action: 'auto_rejected', reason, existing_node_id }`
- Mock returns `auto_resolved` → handler returns `{ stored: true, action: 'auto_resolved', node_id, sensitivity }`

---

## Files changed

| File | Change |
|------|--------|
| `src/memory/types.ts` | Add `auto_rejected` and `auto_resolved` variants to `ValidationResult` |
| `src/memory/validation.ts` | Implement three-branch confidence comparison in `validateContradiction` |
| `src/memory/knowledge-graph.ts` | Add `confidence?` to `updateNode` updates parameter |
| `src/memory/entity-memory.ts` | Add `auto_rejected` / `auto_resolved` to `StoreFactResult.action`; add two `switch` cases in `storeFact` |
| `skills/memory-store/handler.ts` | Add `case 'auto_rejected'` to the `switch` |
| `skills/extract-facts/handler.ts` | Handle `auto_rejected` and `auto_resolved` in the result-processing loop |
| `tests/unit/memory/validation.test.ts` | New test cases for the two new paths |
| `tests/unit/memory/entity-memory.*.test.ts` | Integration tests for `storeFact` auto-resolution |
| `skills/memory-store/handler.test.ts` | Two new handler test cases |
