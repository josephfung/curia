# resolveOrCreate Type Hint Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a warning log and test coverage for the single-match type-mismatch edge case in `EntityMemory.resolveOrCreate()`.

**Architecture:** No structural changes. One method gets a type check + log call in its existing 1-match branch. One test is added to the existing test file.

**Tech Stack:** TypeScript, pino (Logger), Vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/memory/entity-memory.ts:287-289` | Add type-mismatch warning log + comment in the 1-match branch |
| Modify | `src/memory/entity-memory.resolve-or-create.test.ts:100` | Add test for 1-match type-mismatch scenario |

---

### Task 1: Test the type-mismatch behaviour

**Files:**
- Modify: `src/memory/entity-memory.resolve-or-create.test.ts` (insert after line 100, before the closing of the `resolveOrCreate` describe block)

- [ ] **Step 1: Write the failing test**

Insert this test after the "returns ambiguous when 2+ labels match" test (after line 100), inside the existing `describe('EntityMemory.resolveOrCreate', ...)` block:

```typescript
  it('returns found (with existing type) when 1 match exists but type differs from caller hint', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Acme', properties: {}, source: 'test',
    });

    const result = await mem.resolveOrCreate({
      label: 'Acme',
      type: 'organization',  // differs from the existing 'person' node
      source: 'test',
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('narrowing');
    expect(result.node.id).toBe(entity.id);
    expect(result.node.type).toBe('person');  // returns the existing node as-is
  });
```

- [ ] **Step 2: Run the test to verify it passes (current behaviour already returns `found`)**

Run: `npm --prefix /path/to/worktree run test -- src/memory/entity-memory.resolve-or-create.test.ts`

Expected: PASS — the current code already returns `found` for a single match regardless of type. This test locks in that behaviour.

- [ ] **Step 3: Commit the test**

```bash
git add src/memory/entity-memory.resolve-or-create.test.ts
git commit -m "test(memory): cover 1-match type-mismatch in resolveOrCreate (#474)"
```

---

### Task 2: Add the warning log

**Files:**
- Modify: `src/memory/entity-memory.ts:287-289`

- [ ] **Step 1: Replace the 1-match branch**

In `src/memory/entity-memory.ts`, replace lines 287-289:

```typescript
    if (matches.length === 1) {
      return { kind: 'found', node: matches[0]! };
    }
```

with:

```typescript
    if (matches.length === 1) {
      const node = matches[0]!;
      // Single-match returns 'found' even when the type doesn't match the caller's
      // hint. This is intentional: a lone label match almost always represents the
      // same real-world entity under a different type classification. The 2+ path
      // uses type as a tiebreaker because multiple nodes genuinely share a name;
      // with one match there is nothing to disambiguate. We log a warning so
      // operators can spot patterns that suggest genuinely distinct entities.
      // See: https://github.com/josephfung/curia/issues/474
      if (node.type !== options.type) {
        this.logger.warn(
          { label: options.label, expectedType: options.type, actualType: node.type, nodeId: node.id },
          'resolveOrCreate: single match type differs from caller hint',
        );
      }
      return { kind: 'found', node };
    }
```

- [ ] **Step 2: Run the full test file to verify nothing broke**

Run: `npm --prefix /path/to/worktree run test -- src/memory/entity-memory.resolve-or-create.test.ts`

Expected: All 7 tests pass (the 6 existing + the 1 added in Task 1).

- [ ] **Step 3: Commit the implementation**

```bash
git add src/memory/entity-memory.ts
git commit -m "feat(memory): log warning on resolveOrCreate single-match type mismatch (#474)"
```

---

### Task 3: Update CHANGELOG and final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry**

Under `## [Unreleased]`, in the **Changed** section (create it if it doesn't exist), add:

```markdown
- **Entity resolution:** `resolveOrCreate` now logs a warning when a single label match has a different type than the caller's hint, improving observability without changing resolution behaviour ([#474](https://github.com/josephfung/curia/issues/474))
```

- [ ] **Step 2: Run the full test suite**

Run: `npm --prefix /path/to/worktree test`

Expected: All tests pass.

- [ ] **Step 3: Commit the changelog**

```bash
git add CHANGELOG.md
git commit -m "chore: changelog entry for resolveOrCreate type hint warning (#474)"
```
