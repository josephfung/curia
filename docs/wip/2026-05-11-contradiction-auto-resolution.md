# Contradiction Auto-Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three-branch confidence comparison in `validateContradiction` so contradicting facts are auto-rejected (higher existing confidence), auto-resolved with an audit trail (lower existing confidence), or escalated for human review (equal confidence — unchanged).

**Architecture:** Two new `ValidationResult` variants (`auto_rejected`, `auto_resolved`) flow through `storeFact` into `StoreFactResult`, then surface in both skill handlers. `KnowledgeGraphStore.updateNode` gains a `confidence` parameter so the auto-resolve path can raise the stored confidence. The `previous_values` audit trail is an append-only array stored in the fact node's `properties`.

**Tech Stack:** TypeScript ESM, Vitest, node-pg (Postgres via in-memory backend for unit tests), pino

---

## File Map

| File | Change |
|------|--------|
| `src/memory/types.ts` | Add `auto_rejected` and `auto_resolved` variants to `ValidationResult` |
| `src/memory/validation.ts` | Three-branch confidence comparison in `validateContradiction` |
| `src/memory/knowledge-graph.ts` | Add `confidence?` to `updateNode` updates parameter |
| `src/memory/entity-memory.ts` | Add `auto_rejected`/`auto_resolved` to `StoreFactResult.action`; two new `storeFact` cases |
| `skills/memory-store/handler.ts` | Add `case 'auto_rejected'` and dead `case 'auto_resolved'` to exhaustive switch |
| `skills/extract-facts/handler.ts` | Update comment; add info log for `auto_resolved` |
| `tests/unit/memory/validation.test.ts` | Four new contradiction tests |
| `src/memory/entity-memory.resolve-or-create.test.ts` | Two new `storeFact` integration tests |
| `skills/memory-store/handler.test.ts` | Two new handler tests |
| `CHANGELOG.md` | Entry under `## [Unreleased]` |

---

### Task 1: Widen `ValidationResult` type

**Files:**
- Modify: `src/memory/types.ts`

- [ ] **Step 1: Add the two new variants**

In `src/memory/types.ts`, replace the `ValidationResult` type (lines 122–128) with:

```typescript
export type ValidationResult =
  | { action: 'create'; validated: ValidatedFactData }
  | { action: 'update'; existingNodeId: string; mergedProperties: Record<string, unknown> }
  | { action: 'conflict'; existingNodeId: string; reason: string }
  | { action: 'auto_rejected'; existingNodeId: string; reason: string }
  | {
      action: 'auto_resolved';
      existingNodeId: string;
      newLabel: string;
      newProperties: Record<string, unknown>;
      newConfidence: number;
      reason: string;
    }
  | { action: 'entity_not_found'; reason: string }
  | { action: 'rate_limited'; reason: string };
```

- [ ] **Step 2: Run typecheck — new variants expand the union; no existing callsite breaks**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve run typecheck
```

Expected: exits 0

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add src/memory/types.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "feat(memory): add auto_rejected and auto_resolved variants to ValidationResult"
```

---

### Task 2: Widen `StoreFactResult` and update the `memory-store` exhaustive switch

Adding the new action codes to `StoreFactResult.action` breaks the exhaustive `_exhaustive: never` switch in `memory-store/handler.ts`. Both files change in the same commit.

**Files:**
- Modify: `src/memory/entity-memory.ts`
- Modify: `skills/memory-store/handler.ts`

- [ ] **Step 1: Extend `StoreFactResult.action`**

In `src/memory/entity-memory.ts`, find the `StoreFactResult` interface (around line 46–66). Change the `action` field:

```typescript
action: 'created' | 'updated' | 'conflict' | 'auto_rejected' | 'auto_resolved' | 'entity_not_found' | 'rate_limited';
```

- [ ] **Step 2: Add the two new cases to the switch in `memory-store/handler.ts`**

Open `skills/memory-store/handler.ts`. The current switch (around line 215) has cases for `entity_not_found` and `rate_limited` followed by a `default` exhaustive check. Add the two new cases before `default`:

```typescript
case 'auto_rejected':
  // Auto-rejected: existing fact had higher confidence — write was dropped.
  // Surface to the agent so it knows the write was skipped and why.
  ctx.log.info(
    { entity, field, existingNodeId: result.existingNodeId },
    'memory-store: fact auto-rejected — existing has higher confidence',
  );
  return {
    success: true,
    data: {
      stored: false,
      action: 'auto_rejected',
      reason: result.conflict,
      existing_node_id: result.existingNodeId,
    },
  };
case 'auto_resolved':
  // Unreachable at runtime: auto_resolved has stored=true and is handled by
  // the `if (result.stored)` block above. TypeScript cannot narrow result.action
  // through the stored boolean check, so this case is required to keep the
  // exhaustive switch type-correct.
  throw new Error('memory-store: unreachable — auto_resolved must be handled in the stored=true branch');
```

- [ ] **Step 3: Run typecheck**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve run typecheck
```

Expected: exits 0

- [ ] **Step 4: Run existing memory-store tests to confirm no regressions**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose skills/memory-store/handler.test.ts
```

Expected: all existing tests pass

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add src/memory/entity-memory.ts skills/memory-store/handler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "feat(memory): widen StoreFactResult.action; update memory-store switch for new variants"
```

---

### Task 3: Implement `auto_rejected` in `validateContradiction` (TDD)

**Files:**
- Modify: `tests/unit/memory/validation.test.ts`
- Modify: `src/memory/validation.ts`

- [ ] **Step 1: Write failing tests**

In `tests/unit/memory/validation.test.ts`, inside the existing `describe('contradiction detection', ...)` block, add after the last existing test:

```typescript
it('auto-rejects when existing fact has higher confidence', async () => {
  const entity = await store.createNode({
    type: 'person', label: 'Bob', properties: {}, source: 'test',
  });
  const existingFact = await store.createNode({
    type: 'fact',
    label: 'Bob lives in Kitchener',
    properties: { attribute: 'location' },
    confidence: 0.9,
    source: 'test',
  });
  await store.createEdge({
    sourceNodeId: entity.id,
    targetNodeId: existingFact.id,
    type: 'relates_to',
    properties: {},
    source: 'test',
  });

  const result = await validator.validateContradiction({
    entityNodeId: entity.id,
    label: 'Bob lives in Toronto',
    properties: { attribute: 'location' },
    confidence: 0.7, // lower than existing 0.9
    source: 'agent:coordinator/task:t1/channel:email',
  });

  expect(result.action).toBe('auto_rejected');
  if (result.action === 'auto_rejected') {
    expect(result.reason).toContain('Kitchener');
    expect(result.reason).toContain('Toronto');
    expect(result.reason).toContain('0.9');
    expect(result.reason).toContain('0.7');
  }
});

it('preserves the existingNodeId in auto_rejected result', async () => {
  const entity = await store.createNode({
    type: 'person', label: 'Bob', properties: {}, source: 'test',
  });
  const existingFact = await store.createNode({
    type: 'fact',
    label: 'Bob works at Acme',
    properties: { attribute: 'employer' },
    confidence: 0.95,
    source: 'test',
  });
  await store.createEdge({
    sourceNodeId: entity.id,
    targetNodeId: existingFact.id,
    type: 'relates_to',
    properties: {},
    source: 'test',
  });

  const result = await validator.validateContradiction({
    entityNodeId: entity.id,
    label: 'Bob works at Globex',
    properties: { attribute: 'employer' },
    confidence: 0.5,
    source: 'test',
  });

  expect(result.action).toBe('auto_rejected');
  if (result.action === 'auto_rejected') {
    expect(result.existingNodeId).toBe(existingFact.id);
  }
});
```

- [ ] **Step 2: Run to verify both new tests fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose tests/unit/memory/validation.test.ts
```

Expected: 2 new tests FAIL — `Expected 'conflict' to be 'auto_rejected'`

- [ ] **Step 3: Implement the `auto_rejected` branch**

In `src/memory/validation.ts`, find the `if (targetNode.label !== options.label)` block inside `validateContradiction` (around line 185). Replace the entire body of that `if` block with:

```typescript
if (targetNode.label !== options.label) {
  const existingConfidence = targetNode.temporal.confidence;
  const incomingConfidence = options.confidence;

  if (existingConfidence > incomingConfidence) {
    // Spec line 121: existing fact has higher confidence — reject incoming write
    return {
      action: 'auto_rejected',
      existingNodeId: targetNode.id,
      reason: `Existing fact "${targetNode.label}" (confidence: ${existingConfidence}) has higher confidence than incoming "${options.label}" (confidence: ${incomingConfidence}) — write rejected`,
    };
  }

  // existingConfidence <= incomingConfidence:
  // auto_resolved path (existingConfidence < incomingConfidence) is implemented in Task 4.
  // For now, all non-rejection contradictions still escalate to the user.
  // @TODO: Implement auto_resolved path (spec line 122)
  return {
    action: 'conflict',
    existingNodeId: targetNode.id,
    reason: `Contradicting fact: existing "${targetNode.label}" (confidence: ${existingConfidence}) vs new "${options.label}" (confidence: ${incomingConfidence})`,
  };
}
```

- [ ] **Step 4: Run tests — all should pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose tests/unit/memory/validation.test.ts
```

Expected: ALL tests pass (new `auto_rejected` tests + all existing tests including equal-confidence `conflict` regression)

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add tests/unit/memory/validation.test.ts src/memory/validation.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "feat(memory): implement auto_rejected branch in validateContradiction"
```

---

### Task 4: Implement `auto_resolved` in `validateContradiction` (TDD)

**Files:**
- Modify: `tests/unit/memory/validation.test.ts`
- Modify: `src/memory/validation.ts`

- [ ] **Step 1: Write failing tests**

Add to the `describe('contradiction detection', ...)` block:

```typescript
it('auto-resolves when existing fact has lower confidence', async () => {
  const entity = await store.createNode({
    type: 'person', label: 'Bob', properties: {}, source: 'test',
  });
  const existingFact = await store.createNode({
    type: 'fact',
    label: 'Bob lives in Kitchener',
    properties: { attribute: 'location' },
    confidence: 0.6,
    source: 'test',
  });
  await store.createEdge({
    sourceNodeId: entity.id,
    targetNodeId: existingFact.id,
    type: 'relates_to',
    properties: {},
    source: 'test',
  });

  const result = await validator.validateContradiction({
    entityNodeId: entity.id,
    label: 'Bob lives in Toronto',
    properties: { attribute: 'location' },
    confidence: 0.9, // higher than existing 0.6
    source: 'agent:coordinator/task:t1/channel:email',
  });

  expect(result.action).toBe('auto_resolved');
  if (result.action === 'auto_resolved') {
    expect(result.existingNodeId).toBe(existingFact.id);
    expect(result.newLabel).toBe('Bob lives in Toronto');
    expect(result.newConfidence).toBe(0.9);

    const pv = result.newProperties.previous_values as Array<{
      label: string; confidence: number; replacedAt: string; replacedBy: string;
    }>;
    expect(Array.isArray(pv)).toBe(true);
    expect(pv).toHaveLength(1);
    expect(pv[0]!.label).toBe('Bob lives in Kitchener');
    expect(pv[0]!.confidence).toBe(0.6);
    expect(pv[0]!.replacedBy).toBe('agent:coordinator/task:t1/channel:email');
    expect(typeof pv[0]!.replacedAt).toBe('string');
  }
});

it('appends to previous_values when a fact is superseded a second time', async () => {
  const entity = await store.createNode({
    type: 'person', label: 'Bob', properties: {}, source: 'test',
  });
  // Existing fact already has one previous_values entry from a prior supersession
  const existingFact = await store.createNode({
    type: 'fact',
    label: 'Bob lives in Toronto',
    properties: {
      attribute: 'location',
      previous_values: [
        {
          label: 'Bob lives in Kitchener',
          confidence: 0.5,
          replacedAt: '2026-01-01T00:00:00.000Z',
          replacedBy: 'agent:coordinator/task:t0/channel:email',
        },
      ],
    },
    confidence: 0.7,
    source: 'test',
  });
  await store.createEdge({
    sourceNodeId: entity.id,
    targetNodeId: existingFact.id,
    type: 'relates_to',
    properties: {},
    source: 'test',
  });

  const result = await validator.validateContradiction({
    entityNodeId: entity.id,
    label: 'Bob lives in Vancouver',
    properties: { attribute: 'location' },
    confidence: 0.95,
    source: 'agent:coordinator/task:t2/channel:signal',
  });

  expect(result.action).toBe('auto_resolved');
  if (result.action === 'auto_resolved') {
    const pv = result.newProperties.previous_values as Array<{ label: string }>;
    expect(pv).toHaveLength(2);
    expect(pv[0]!.label).toBe('Bob lives in Kitchener');
    expect(pv[1]!.label).toBe('Bob lives in Toronto');
  }
});
```

- [ ] **Step 2: Run to verify both new tests fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose tests/unit/memory/validation.test.ts
```

Expected: 2 new tests FAIL — `Expected 'conflict' to be 'auto_resolved'`

- [ ] **Step 3: Implement the full three-branch logic**

In `src/memory/validation.ts`, replace the entire `if (targetNode.label !== options.label)` block (including the `@TODO` comment from Task 3) with:

```typescript
if (targetNode.label !== options.label) {
  const existingConfidence = targetNode.temporal.confidence;
  const incomingConfidence = options.confidence;

  if (existingConfidence > incomingConfidence) {
    // Spec line 121: existing fact has higher confidence — reject incoming write
    return {
      action: 'auto_rejected',
      existingNodeId: targetNode.id,
      reason: `Existing fact "${targetNode.label}" (confidence: ${existingConfidence}) has higher confidence than incoming "${options.label}" (confidence: ${incomingConfidence}) — write rejected`,
    };
  }

  if (existingConfidence < incomingConfidence) {
    // Spec line 122: incoming has higher confidence — supersede existing fact,
    // preserving the old value in an append-only previous_values audit trail.
    const existingPreviousValues = Array.isArray(targetNode.properties.previous_values)
      ? (targetNode.properties.previous_values as Array<Record<string, unknown>>)
      : [];

    return {
      action: 'auto_resolved',
      existingNodeId: targetNode.id,
      newLabel: options.label,
      newConfidence: incomingConfidence,
      newProperties: {
        ...targetNode.properties,
        ...(options.properties ?? {}),
        previous_values: [
          ...existingPreviousValues,
          {
            label: targetNode.label,
            confidence: existingConfidence,
            replacedAt: new Date().toISOString(),
            replacedBy: options.source,
          },
        ],
      },
      reason: `Incoming fact "${options.label}" (confidence: ${incomingConfidence}) supersedes existing "${targetNode.label}" (confidence: ${existingConfidence}) — previous value preserved in properties.previous_values`,
    };
  }

  // Spec line 123: equal confidence — flag for human review
  return {
    action: 'conflict',
    existingNodeId: targetNode.id,
    reason: `Contradicting fact: existing "${targetNode.label}" (confidence: ${existingConfidence}) vs new "${options.label}" (confidence: ${incomingConfidence})`,
  };
}
```

Also remove the old `@TODO` comment block above `return { action: 'conflict', ... }` that referenced spec lines 121-123 (it's now implemented).

- [ ] **Step 4: Run all validation tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose tests/unit/memory/validation.test.ts
```

Expected: ALL tests pass — including the equal-confidence regression test (`conflict`) and all four new tests

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add tests/unit/memory/validation.test.ts src/memory/validation.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "feat(memory): implement auto_resolved branch in validateContradiction with previous_values audit trail"
```

---

### Task 5: Add `confidence` parameter to `KnowledgeGraphStore.updateNode`

**Files:**
- Modify: `src/memory/knowledge-graph.ts`

- [ ] **Step 1: Extend the `updateNode` signature and body**

In `src/memory/knowledge-graph.ts`, find `KnowledgeGraphStore.updateNode` (around line 192). Replace the `updates` parameter type and the `temporal` assembly:

```typescript
async updateNode(
  id: string,
  updates: {
    label?: string;
    properties?: Record<string, unknown>;
    sensitivity?: Sensitivity;
    confidence?: number; // ← new: allows auto_resolved to raise stored confidence
  },
): Promise<KgNode> {
  const existing = await this.backend.getNode(id);
  if (!existing) {
    throw new Error(`Node not found: ${id}`);
  }

  const labelChanged = updates.label !== undefined && updates.label !== existing.label;

  const updated: KgNode = {
    ...existing,
    label: updates.label ?? existing.label,
    properties: updates.properties ?? existing.properties,
    sensitivity: updates.sensitivity ?? existing.sensitivity,
    embedding: labelChanged
      ? await this.embeddingService.embed(updates.label!)
      : existing.embedding,
    temporal: {
      ...existing.temporal,
      lastConfirmedAt: new Date(),
      confidence: updates.confidence ?? existing.temporal.confidence, // ← new
    },
  };

  await this.backend.updateNode(id, updated);
  return updated;
}
```

- [ ] **Step 2: Run typecheck and full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve run typecheck
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test
```

Expected: both exit 0

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add src/memory/knowledge-graph.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "feat(memory): add confidence parameter to KnowledgeGraphStore.updateNode"
```

---

### Task 6: Implement `auto_rejected` in `storeFact` (TDD)

**Files:**
- Modify: `src/memory/entity-memory.resolve-or-create.test.ts`
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Write a failing test**

In `src/memory/entity-memory.resolve-or-create.test.ts`, add a new `describe` block after the existing `describe('EntityMemory.storeFact — updated action codes', ...)`:

```typescript
describe('EntityMemory.storeFact — contradiction auto-resolution', () => {
  it('returns auto_rejected and leaves existing node unchanged when incoming confidence is lower', async () => {
    const { mem, store } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Bob', properties: {}, source: 'test',
    });

    // Store a high-confidence location fact first
    const initial = await mem.storeFact({
      entityNodeId: entity.id,
      label: 'location: Kitchener',
      properties: { attribute: 'location', value: 'Kitchener' },
      confidence: 0.9,
      source: 'test',
    });
    expect(initial.action).toBe('created');
    const existingNodeId = initial.nodeId!;

    // Attempt to override with lower confidence
    const result = await mem.storeFact({
      entityNodeId: entity.id,
      label: 'location: Toronto',
      properties: { attribute: 'location', value: 'Toronto' },
      confidence: 0.7,
      source: 'agent:coordinator/task:t1/channel:email',
    });

    expect(result.stored).toBe(false);
    expect(result.action).toBe('auto_rejected');
    expect(result.conflict).toContain('Kitchener');
    expect(result.existingNodeId).toBe(existingNodeId);

    // The existing node must be untouched
    const existingNode = await store.getNode(existingNodeId);
    expect(existingNode?.label).toBe('location: Kitchener');
    expect(existingNode?.temporal.confidence).toBe(0.9);
  });
});
```

- [ ] **Step 2: Run to verify the test fails**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: new test FAILS — `storeFact` has no `case 'auto_rejected'` yet, so it falls to the exhaustive `throw` and causes an error

- [ ] **Step 3: Add `auto_rejected` case to `storeFact`**

In `src/memory/entity-memory.ts`, in the `switch (result.action)` block inside `storeFact`, add after `case 'conflict':`:

```typescript
case 'auto_rejected':
  // Spec line 121: incoming confidence was lower — write dropped, no store update.
  this.logger.info(
    {
      entityNodeId: options.entityNodeId,
      existingNodeId: result.existingNodeId,
      reason: result.reason,
    },
    'storeFact: incoming fact auto-rejected — existing fact has higher confidence',
  );
  return {
    stored: false,
    action: 'auto_rejected',
    conflict: result.reason,
    existingNodeId: result.existingNodeId,
  };
```

- [ ] **Step 4: Run tests — all should pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: ALL tests pass

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add src/memory/entity-memory.resolve-or-create.test.ts src/memory/entity-memory.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "feat(memory): implement auto_rejected case in storeFact"
```

---

### Task 7: Implement `auto_resolved` in `storeFact` (TDD)

**Files:**
- Modify: `src/memory/entity-memory.resolve-or-create.test.ts`
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Write a failing test**

Add to the `describe('EntityMemory.storeFact — contradiction auto-resolution', ...)` block:

```typescript
it('returns auto_resolved, updates existing node label and confidence, and populates previous_values', async () => {
  const { mem, store } = makeEntityMemory();
  const { entity } = await mem.createEntity({
    type: 'person', label: 'Bob', properties: {}, source: 'test',
  });

  // Store initial lower-confidence location fact
  const initial = await mem.storeFact({
    entityNodeId: entity.id,
    label: 'location: Kitchener',
    properties: { attribute: 'location', value: 'Kitchener' },
    confidence: 0.6,
    source: 'test',
  });
  expect(initial.action).toBe('created');
  const existingNodeId = initial.nodeId!;

  // Supersede with higher-confidence fact
  const result = await mem.storeFact({
    entityNodeId: entity.id,
    label: 'location: Toronto',
    properties: { attribute: 'location', value: 'Toronto' },
    confidence: 0.9,
    source: 'agent:coordinator/task:t1/channel:email',
  });

  expect(result.stored).toBe(true);
  expect(result.action).toBe('auto_resolved');
  // Same node ID — the existing node was updated in place, not replaced
  expect(result.nodeId).toBe(existingNodeId);

  // Verify node was updated in the store
  const updatedNode = await store.getNode(existingNodeId);
  expect(updatedNode?.label).toBe('location: Toronto');
  expect(updatedNode?.temporal.confidence).toBe(0.9);

  // Verify audit trail
  const pv = updatedNode!.properties.previous_values as Array<{
    label: string; confidence: number; replacedBy: string;
  }>;
  expect(Array.isArray(pv)).toBe(true);
  expect(pv).toHaveLength(1);
  expect(pv[0]!.label).toBe('location: Kitchener');
  expect(pv[0]!.confidence).toBe(0.6);
  expect(pv[0]!.replacedBy).toBe('agent:coordinator/task:t1/channel:email');
});
```

- [ ] **Step 2: Run to verify the test fails**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: new test FAILS — `storeFact` has no `case 'auto_resolved'` yet

- [ ] **Step 3: Add `auto_resolved` case to `storeFact`**

In `src/memory/entity-memory.ts`, after the `case 'auto_rejected':` block, add:

```typescript
case 'auto_resolved': {
  // Spec line 122: incoming confidence is higher — update the existing fact node
  // with the new label, confidence, and properties (which include the previous_values
  // audit trail already built by the validator).

  // Resolve sensitivity — ratchet: merged content can only increase, never decrease.
  const existingNodeForSensitivity = await this.store.getNode(result.existingNodeId);
  const sensitivityFallback = existingNodeForSensitivity === undefined;
  const existingSensitivity: Sensitivity = existingNodeForSensitivity?.sensitivity ?? 'internal';
  const incomingSensitivity: Sensitivity = options.sensitivity
    ?? this.sensitivityClassifier?.classify(
      result.newLabel,
      result.newProperties,
      options.sensitivityCategory,
    )
    ?? 'internal';
  const sensitivity = maxSensitivity(existingSensitivity, incomingSensitivity);

  await this.store.updateNode(result.existingNodeId, {
    label: result.newLabel,
    properties: result.newProperties,
    confidence: result.newConfidence,
    sensitivity,
  });

  this.validator.recordWrite(options.source);

  return {
    stored: true,
    action: 'auto_resolved',
    nodeId: result.existingNodeId,
    sensitivity,
    sensitivityFallback,
  };
}
```

- [ ] **Step 4: Run all entity-memory tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose src/memory/entity-memory.resolve-or-create.test.ts
```

Expected: ALL tests pass

- [ ] **Step 5: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add src/memory/entity-memory.resolve-or-create.test.ts src/memory/entity-memory.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "feat(memory): implement auto_resolved case in storeFact with confidence update and previous_values audit trail"
```

---

### Task 8: Add handler tests for `auto_rejected` and `auto_resolved`

**Files:**
- Modify: `skills/memory-store/handler.test.ts`

The handler cases were added in Task 2 (`auto_rejected` real, `auto_resolved` dead branch). Now add tests to confirm the handler surfaces each correctly.

- [ ] **Step 1: Write the two new test cases**

In `skills/memory-store/handler.test.ts`, add two new `describe` blocks after the existing `describe('action: entity_not_found ...')` block, following the same pattern as the existing mock tests:

```typescript
describe('action: auto_rejected', () => {
  it('returns auto_rejected with reason and existing_node_id', async () => {
    const ctx = {
      input: VALID_INPUT,
      secret: () => 'test-key',
      log: pino({ level: 'silent' }),
      entityMemory: makeMockEntityMemory({
        stored: false,
        action: 'auto_rejected',
        conflict: 'Existing fact "location: Kitchener" (confidence: 0.9) has higher confidence than incoming "location: Toronto" (confidence: 0.7) — write rejected',
        existingNodeId: 'existing-node-123',
      }),
    } as unknown as SkillContext;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.stored).toBe(false);
    expect(data.action).toBe('auto_rejected');
    expect(String(data.reason)).toContain('Kitchener');
    expect(data.existing_node_id).toBe('existing-node-123');
  });
});

describe('action: auto_resolved', () => {
  it('returns auto_resolved as a stored fact with node_id and sensitivity', async () => {
    const ctx = {
      input: VALID_INPUT,
      secret: () => 'test-key',
      log: pino({ level: 'silent' }),
      entityMemory: makeMockEntityMemory({
        stored: true,
        action: 'auto_resolved',
        nodeId: 'existing-node-123',
        sensitivity: 'internal',
      }),
    } as unknown as SkillContext;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.stored).toBe(true);
    expect(data.action).toBe('auto_resolved');
    expect(data.node_id).toBe('existing-node-123');
    expect(data.sensitivity).toBe('internal');
  });
});
```

- [ ] **Step 2: Run to verify both new tests pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test -- --reporter=verbose skills/memory-store/handler.test.ts
```

Expected: all tests pass (including the two new ones)

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add skills/memory-store/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "test(memory-store): add handler tests for auto_rejected and auto_resolved"
```

---

### Task 9: Update `extract-facts` handler comments and logging

**Files:**
- Modify: `skills/extract-facts/handler.ts`

Both new action codes are already handled correctly by the existing branch structure:
- `auto_resolved` (`stored: true`) → increments `stored` counter (line 241–242)
- `auto_rejected` (`stored: false`, not `rate_limited`) → falls to the `else` warn log (line 253–255)

This task only updates the comment and adds an info log for `auto_resolved` visibility.

- [ ] **Step 1: Update the comment and add an `auto_resolved` info log**

In `skills/extract-facts/handler.ts`, find the result-handling block (around line 241–255):

```typescript
// Current:
if (result.stored) {
  stored++;
} else if (result.action === 'rate_limited') {
  // ...
  break;
} else {
  // conflict or entity_not_found — expected semantic outcomes, not infra failures.
  ctx.log.warn({ subject, attribute, conflict: result.conflict, action: result.action, source }, 'extract-facts: fact not stored');
}
```

Replace with:

```typescript
if (result.stored) {
  if (result.action === 'auto_resolved') {
    // Incoming fact superseded a lower-confidence existing fact — audit trail preserved.
    ctx.log.info(
      { subject, attribute, source, nodeId: result.nodeId },
      'extract-facts: fact auto-resolved — existing superseded by higher-confidence incoming',
    );
  }
  stored++;
} else if (result.action === 'rate_limited') {
  // The 50-writes-per-task limit is exhausted — all remaining storeFact calls
  // in this batch will also fail, so break immediately rather than burning
  // through the rest of the loop and mis-reporting them as conflicts.
  ctx.log.error(
    { subject, attribute, source, reason: result.conflict },
    'extract-facts: write rate limit exceeded — aborting remaining facts in batch',
  );
  failed++;
  break;
} else {
  // conflict, auto_rejected, or entity_not_found — expected semantic outcomes, not infra failures.
  ctx.log.warn({ subject, attribute, conflict: result.conflict, action: result.action, source }, 'extract-facts: fact not stored');
}
```

- [ ] **Step 2: Run full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test
```

Expected: all tests pass

- [ ] **Step 3: Run typecheck**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve run typecheck
```

Expected: exits 0

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add skills/extract-facts/handler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "feat(extract-facts): log auto_resolved and auto_rejected outcomes in fact processing loop"
```

---

### Task 10: Update CHANGELOG and final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under `## [Unreleased]`**

Open `CHANGELOG.md`. Under `## [Unreleased]`, add to the `Changed` section (or create it if absent):

```markdown
### Changed
- **Contradiction auto-resolution** (spec 01): `validateContradiction` now auto-rejects incoming facts with lower confidence than the existing contradicting fact, and auto-resolves (updates in place) when the incoming confidence is higher, preserving the old value in a `properties.previous_values` audit trail. Equal-confidence contradictions continue to escalate to human review unchanged.
```

- [ ] **Step 2: Run the full test suite one final time**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve test
```

Expected: all tests pass

- [ ] **Step 3: Run typecheck one final time**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve run typecheck
```

Expected: exits 0

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contradiction-auto-resolve commit -m "chore: changelog entry for contradiction auto-resolution (issue #26)"
```
