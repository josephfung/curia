# extract-facts catch scope fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a latent `ReferenceError` in `skills/extract-facts/handler.ts` where the per-fact `catch` block references `subject` and `attribute` that are declared inside the `try` block.

**Architecture:** Move the two variable declarations before the `try` block with a falsy sentinel (`''`), simplify the malformed-fact guard to use the pre-computed values, and add a regression test that exercises the catch path.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Add a failing regression test for the catch path

**Files:**
- Modify: `skills/extract-facts/handler.test.ts`

This test verifies that when `storeFact` throws (simulating a DB outage), the skill correctly increments `failed` and returns `{ success: true }` — rather than letting a secondary `ReferenceError` escape into the outer catch and returning `{ success: false }`. On the unfixed code, this test will fail because `subject` is not in scope in the catch block.

- [ ] **Step 1: Add the failing test**

Open `skills/extract-facts/handler.test.ts`. Add this test after the existing `'breaks immediately on rate_limited mid-batch'` test (before the closing `});` of the `describe` block):

```typescript
  it('catch block is safe when storeFact throws — failed incremented, no ReferenceError', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', facts]);
    const handler = new ExtractFactsHandler(anthropic as never);

    // Simulate a DB outage — storeFact throws instead of returning a failure result.
    vi.spyOn(entityMemory, 'storeFact').mockRejectedValueOnce(new Error('DB connection lost'));

    const ctx = makeCtx(entityMemory, { text: 'Jane Doe lives in Toronto.', source: 'test' });
    const result = await handler.execute(ctx);

    // The per-fact catch block must handle the error and increment failed.
    // If subject/attribute are not in scope, a ReferenceError escapes to the
    // outer catch and the result is { success: false } — so this assertion
    // distinguishes the two code paths.
    expect(result).toEqual({ success: true, data: { stored: 0, skipped: false, failed: 1 } });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-extract-facts-catch run test -- --reporter=verbose skills/extract-facts/handler.test.ts
```

Expected: the new test fails. The exact failure depends on TypeScript/runtime behaviour, but the result will be `{ success: false }` because the `ReferenceError` for `subject` escapes to the outer catch.

---

### Task 2: Fix the handler — move declarations before the try block

**Files:**
- Modify: `skills/extract-facts/handler.ts:167-257`

- [ ] **Step 1: Replace the for-loop body with the fixed version**

In `skills/extract-facts/handler.ts`, find the `for (const fact of facts) {` loop (around line 167). Replace everything from the opening `for` brace through the closing `}` of the catch block with:

```typescript
      for (const fact of facts) {
        // Declared before try so the catch block can always reference them,
        // even if an exception fires before the assignments inside try would run.
        // Empty string is the safe sentinel — falsy, so the malformed-fact guard
        // below fires correctly when subject or attribute could not be determined.
        let subject = typeof fact?.subject === 'string' ? fact.subject.trim() : '';
        let attribute = typeof fact?.attribute === 'string' ? fact.attribute.trim() : '';

        try {
          // Guard: skip malformed entries where required string fields are absent or blank.
          // Blank strings would create empty-label entities or facts labelled ": ".
          // subject and attribute are pre-computed above; only value needs its typeof check here.
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

          // value is not referenced in the catch block so it stays here.
          const value = fact.value.trim();

          // Normalise subject type — fall back to 'person' for unknown or non-entity types.
          const subjectType: NodeType = ENTITY_NODE_TYPES.has(fact.subjectType)
            ? fact.subjectType as NodeType
            : 'person';

          // Normalise decay class — fall back to 'slow_decay' for unknown values.
          const decayClass: DecayClass = (DECAY_CLASSES as readonly string[]).includes(fact.decayClass)
            ? fact.decayClass as DecayClass
            : 'slow_decay';

          // Clamp confidence to [0, 1] in case the LLM returns an out-of-range value.
          const confidence = typeof fact.confidence === 'number'
            ? Math.min(1, Math.max(0, fact.confidence))
            : 0.7;

          // Resolve entity node — finds or auto-creates via resolveOrCreate().
          // Ambiguous case (2+ nodes, no type match) takes candidates[0] rather than
          // stalling the background batch job with a disambiguation loop.
          const resolved = await ctx.entityMemory.resolveOrCreate({
            label: subject,
            type: subjectType,
            source,
            confidence: 0.6,
          });
          let entityNode;
          if (resolved.kind === 'ambiguous') {
            entityNode = resolved.candidates[0]!;
            ctx.log.warn(
              { subject, candidateCount: resolved.candidates.length, chosenId: entityNode.id },
              'extract-facts: ambiguous subject entity — taking first candidate',
            );
          } else {
            entityNode = resolved.node;
          }

          // Label format: "<attribute>: <value>" — human-readable and dedup-stable.
          // The validator uses semantic similarity on this label for near-duplicate detection.
          const label = `${attribute}: ${value}`;

          const result = await ctx.entityMemory.storeFact({
            entityNodeId: entityNode.id,
            label,
            properties: { attribute, value },
            confidence,
            decayClass,
            source,
          });

          if (result.stored) {
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
            // conflict or entity_not_found — expected semantic outcomes, not infra failures.
            ctx.log.warn({ subject, attribute, conflict: result.conflict, action: result.action, source }, 'extract-facts: fact not stored');
          }
        } catch (err) {
          // Log at error — persistence failures are infrastructure errors (DB outage,
          // connection loss) that must surface in Sentry, not soft warnings.
          // subject and attribute are always in scope here (declared before this try).
          ctx.log.error({ err, subject, attribute }, 'extract-facts: failed to persist fact, skipping');
          failed++;
        }
      }
```

- [ ] **Step 2: Run all extract-facts tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-extract-facts-catch run test -- --reporter=verbose skills/extract-facts/handler.test.ts
```

Expected: all tests pass, including the new regression test.

- [ ] **Step 3: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-extract-facts-catch run test
```

Expected: all tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-extract-facts-catch add skills/extract-facts/handler.ts skills/extract-facts/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-extract-facts-catch commit -m "fix: move subject/attribute declarations before try block in extract-facts (#470)"
```

---

### Task 3: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a Fixed entry under [Unreleased]**

Open `CHANGELOG.md`. Under `## [Unreleased]`, add or append to a `### Fixed` section:

```markdown
### Fixed

- **extract-facts catch scope** — `subject` and `attribute` are now declared before the per-fact `try` block so the `catch` block can always reference them; previously a `ReferenceError` could mask the original error if an exception fired before those `const` declarations ran.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-extract-facts-catch add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-extract-facts-catch commit -m "chore: changelog entry for extract-facts catch scope fix (#470)"
```
