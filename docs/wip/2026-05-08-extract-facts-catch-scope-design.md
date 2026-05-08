# Design: Fix extract-facts catch block variable scope

**Date:** 2026-05-08  
**Issue:** josephfung/curia#470  
**Type:** Bug fix (size:XS)

## Problem

In `skills/extract-facts/handler.ts`, the per-fact `catch` block at line 255 logs
`{ err, subject, attribute }`, but both `subject` and `attribute` are declared with
`const` inside the `try` block (lines 184–185). If an exception occurs before those
`const` declarations execute, the catch block itself throws a `ReferenceError`,
completely hiding the original error.

In practice this path is unreachable with plain JSON objects from the LLM, but it is
a latent footgun that could mask errors if the fact array ever contains non-plain objects
(e.g. from a future deserialization change). TypeScript does not catch this at compile time.

## Fix

### Variable declarations

Move `subject` and `attribute` before the `try` block using `let` with a `''` sentinel:

```typescript
let subject = typeof fact?.subject === 'string' ? fact.subject.trim() : '';
let attribute = typeof fact?.attribute === 'string' ? fact.attribute.trim() : '';
```

Using `''` (empty string, falsy) rather than `'(unknown)'` keeps the existing `!subject`
and `!attribute` guards inside the try block working without modification. An empty string
means "could not determine subject" — which is semantically equivalent to the old
`typeof fact.subject !== 'string'` case that already caused the malformed-fact guard to fire.

### Guard adjustment

Remove the now-redundant `typeof` checks from the malformed-fact guard since they are
already captured in the initialization:

```typescript
if (
  !fact ||
  !subject ||
  !attribute ||
  typeof fact.value !== 'string' || !fact.value.trim()
) {
  ctx.log.warn({ fact }, 'extract-facts: skipping malformed fact');
  failed++;
  continue;
}
```

`value` is not pre-computed (it's not referenced in the catch block) so its `typeof`
check stays inside the guard.

### Downstream usage

`subject` and `attribute` are already trimmed, so all downstream uses inside the try
block (`resolveOrCreate`, `label`, `storeFact` properties) use them directly without
re-trimming.

## New test

Add a test that verifies the catch block path works correctly: mock `storeFact` to throw
(simulating a DB outage), and assert:
- The skill returns `{ success: true, data: { stored: 0, skipped: false, failed: 1 } }`
- No secondary `ReferenceError` is thrown (the skill returns, not throws)

This test directly exercises the latent bug — it would fail on the unfixed code with
a `ReferenceError` escaping into the outer try/catch and returning `{ success: false }`.

## Files changed

- `skills/extract-facts/handler.ts` — move declarations, adjust guard
- `skills/extract-facts/handler.test.ts` — add storeFact-throws test
- `CHANGELOG.md` — add Fixed entry under [Unreleased]

## Acceptance criteria

- [ ] `subject` and `attribute` are declared before the per-fact `try` block
- [ ] The catch block can reference them without risk of `ReferenceError`
- [ ] Existing tests continue to pass
- [ ] New test verifies the catch block path (storeFact throws → failed incremented)
