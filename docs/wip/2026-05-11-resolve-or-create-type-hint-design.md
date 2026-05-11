# resolveOrCreate: Single-Match Type Hint Handling

**Issue:** [#474](https://github.com/josephfung/curia/issues/474)
**Date:** 2026-05-11

## Problem

`EntityMemory.resolveOrCreate()` uses a three-outcome resolution strategy:

- **0 matches** — auto-create with the caller's type
- **1 match** — return `{ kind: 'found', node }` unconditionally
- **2+ matches** — prefer a type-matching node; return `ambiguous` if none matches

The 1-match path returns any label match without checking whether the node's
type matches the caller's type hint. This is inconsistent with the 2+ case,
which explicitly prefers type-matching nodes.

If a caller requests `resolveOrCreate({ label: 'Acme', type: 'organization' })`
and the only match is a `person` node, the method silently returns it.

## Decision

**Keep current behaviour; add observability.**

Cross-type name collisions are rare in practice. Changing the return kind (to
`ambiguous` or `created`) would disrupt callers for a case that almost always
represents the same real-world entity under a different type label.

Both callers already handle `ambiguous` gracefully, but returning it for a
1-match case would add unnecessary round-trips (`memory-store`) or silent
auto-picks (`extract-facts` takes `candidates[0]`) for what is usually a false
alarm.

## Design

### Change 1: Warning log on type mismatch (entity-memory.ts)

In the `matches.length === 1` branch, add a type-mismatch check before
returning. When the single match's type differs from the caller's hint, log a
warning with structured fields:

```typescript
if (matches.length === 1) {
  const node = matches[0]!;
  // Single-match returns 'found' even when the type doesn't match the caller's
  // hint. This is intentional: a lone label match almost always represents the
  // same real-world entity under a different type classification. The 2+ path
  // uses type as a tiebreaker because multiple nodes genuinely share a name;
  // with one match there is nothing to disambiguate. We log a warning so
  // operators can spot patterns that suggest genuinely distinct entities.
  if (node.type !== options.type) {
    this.logger.warn(
      { label: options.label, expectedType: options.type, actualType: node.type, nodeId: node.id },
      'resolveOrCreate: single match type differs from caller hint',
    );
  }
  return { kind: 'found', node };
}
```

### Change 2: Test for 1-match type mismatch (entity-memory.resolve-or-create.test.ts)

Add one test to the existing suite:

- Create a `person` node with label `"Acme"`
- Call `resolveOrCreate({ label: 'Acme', type: 'organization', source: 'test' })`
- Assert `result.kind === 'found'`
- Assert `result.node.type === 'person'` (the existing node, not a new one)

This locks in the intentional behaviour and prevents future regressions.

## What does NOT change

- **Return type:** No new `kind` values, no type changes
- **Callers:** `memory-store` and `extract-facts` are untouched
- **Spec:** `docs/specs/01-memory-system.md` does not prescribe this behaviour
  and needs no update

## Acceptance criteria mapping

From the issue:

- [x] `resolveOrCreate` documents the exact behaviour when 1 match exists and
  its type differs — covered by the inline code comment (Change 1)
- [x] At least one test covers the "1 match, type mismatch" scenario — Change 2
- [x] If behaviour is changed, all callers updated — behaviour is NOT changed,
  so no caller updates needed
