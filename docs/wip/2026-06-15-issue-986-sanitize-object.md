# Issue #986: Execution-layer structural output sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `ExecutionLayer.invoke` so that object-returning skills whose string values contain HTML are sanitized without corrupting the JSON structure.

**Architecture:** Add a new `sanitizeObjectOutput` function to `src/skills/sanitize.ts` that recursively walks an unknown value and applies the existing `sanitizeOutput` to each string leaf. Replace the broken stringify→sanitize→parse branch in `execution.ts` with a single call to `sanitizeObjectOutput`. JSON keys and structural characters never pass through the HTML stripper.

**Tech Stack:** TypeScript (ESM), Vitest, `sanitize-html` (already a dependency via `sanitizeOutput`)

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object`
**Branch:** `fix/986-sanitize-object`

---

### Task 1: Write failing tests for `sanitizeObjectOutput`

**Files:**
- Modify: `tests/unit/skills/sanitize.test.ts`

- [ ] **Step 1: Add the import for `sanitizeObjectOutput`**

Open `tests/unit/skills/sanitize.test.ts`. Change the import at the top from:

```ts
import {
  sanitizeOutput,
  sanitizeDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
} from '../../../src/skills/sanitize.js';
```

to:

```ts
import {
  sanitizeOutput,
  sanitizeDisplayName,
  sanitizeObjectOutput,
  DISPLAY_NAME_MAX_LENGTH,
} from '../../../src/skills/sanitize.js';
```

- [ ] **Step 2: Add the test suite at the end of the file**

Append this block after the last `describe` block:

```ts
describe('sanitizeObjectOutput', () => {
  it('passes a plain object with no HTML or secrets through unchanged', () => {
    const input = { count: 3, label: 'hello world', active: true, nothing: null };
    const result = sanitizeObjectOutput(input);
    expect(result).toEqual(input);
  });

  it('strips dangerous HTML tags from string leaf values', () => {
    const input = { body: '<style>x{}</style><div>"quoted"</div>' };
    const result = sanitizeObjectOutput(input) as { body: string };
    // Dangerous tag and its content removed
    expect(result.body).not.toContain('<style>');
    expect(result.body).not.toContain('x{}');
    // Safe content preserved
    expect(result.body).toContain('"quoted"');
    // Result is still a plain object, not a string
    expect(typeof result).toBe('object');
    expect(typeof result.body).toBe('string');
  });

  it('preserves JSON structure: keys, nesting, arrays, non-string values', () => {
    const input = {
      messages: [
        { id: 1, body: 'hello <b>world</b>', read: false },
        { id: 2, body: 'clean text', read: true },
      ],
      count: 2,
    };
    const result = sanitizeObjectOutput(input) as typeof input;
    expect(result.count).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.id).toBe(1);
    expect(result.messages[0]!.read).toBe(false);
    expect(result.messages[1]!.id).toBe(2);
    expect(result.messages[1]!.read).toBe(true);
    // HTML stripped from body values
    expect(result.messages[0]!.body).not.toContain('<b>');
    expect(result.messages[0]!.body).toContain('world');
    expect(result.messages[1]!.body).toBe('clean text');
  });

  it('redacts secrets from string leaf values', () => {
    const input = { token: 'sk-ant-api03-abcdefghijk1234567890', label: 'keep this' };
    const result = sanitizeObjectOutput(input) as { token: string; label: string };
    expect(result.token).not.toContain('sk-ant-api03-abcdefghijk1234567890');
    expect(result.token).toContain('[REDACTED]');
    expect(result.label).toBe('keep this');
  });

  it('applies maxLength truncation per string leaf independently', () => {
    const suffix = '[truncated — output exceeded limit]';
    const long = 'x'.repeat(200);
    const short = 'hello';
    const input = { a: long, b: short };
    const result = sanitizeObjectOutput(input, { maxLength: 100 }) as { a: string; b: string };
    // Long value truncated
    expect(result.a).toContain(suffix);
    expect(result.a.length).toBeLessThanOrEqual(100 + suffix.length);
    // Short value unaffected — per-value truncation, not shared budget
    expect(result.b).toBe('hello');
  });

  it('forwards skipSecretRedaction to leaf sanitization', () => {
    const token = 'a'.repeat(64); // 64-char hex token
    const input = { link: `https://host/capture/${token}` };
    // With skipSecretRedaction: token survives
    const kept = sanitizeObjectOutput(input, { skipSecretRedaction: true }) as { link: string };
    expect(kept.link).toContain(token);
    // Without it: token is redacted
    const redacted = sanitizeObjectOutput(input) as { link: string };
    expect(redacted.link).toContain('[REDACTED]');
    expect(redacted.link).not.toContain(token);
  });

  // Regression test from issue #986 acceptance criteria
  it('regression: object with HTML-body message round-trips to valid object with dangerous tags removed', () => {
    const input = { messages: [{ body: '<style>x{}</style><div>"quoted"</div>' }] };
    const result = sanitizeObjectOutput(input) as { messages: Array<{ body: string }> };
    // Still a structured object
    expect(typeof result).toBe('object');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(typeof result.messages[0]!.body).toBe('string');
    // Dangerous content removed
    expect(result.messages[0]!.body).not.toContain('<style>');
    expect(result.messages[0]!.body).not.toContain('x{}');
    // Safe content preserved
    expect(result.messages[0]!.body).toContain('"quoted"');
  });

  it('passes through number, boolean, null, and undefined leaf values unchanged', () => {
    const input = { n: 42, b: false, nil: null };
    const result = sanitizeObjectOutput(input);
    expect(result).toEqual({ n: 42, b: false, nil: null });
  });

  it('handles arrays at the top level', () => {
    const input = [{ body: '<script>evil()</script>hello' }, { body: 'clean' }];
    const result = sanitizeObjectOutput(input) as Array<{ body: string }>;
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]!.body).not.toContain('evil');
    expect(result[0]!.body).toContain('hello');
    expect(result[1]!.body).toBe('clean');
  });
});
```

- [ ] **Step 3: Run the tests — confirm they fail**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object run test tests/unit/skills/sanitize.test.ts
```

Expected: tests in the `sanitizeObjectOutput` suite **FAIL** with something like
`SyntaxError: The requested module ... does not provide an export named 'sanitizeObjectOutput'`
or import resolution error. The existing `sanitizeOutput` and `sanitizeDisplayName` tests must still **PASS**.

- [ ] **Step 4: Commit the failing tests**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object add tests/unit/skills/sanitize.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object commit -m "test: add failing tests for sanitizeObjectOutput (#986)"
```

---

### Task 2: Implement `sanitizeObjectOutput` in `sanitize.ts`

**Files:**
- Modify: `src/skills/sanitize.ts`

- [ ] **Step 1: Add the function at the end of `src/skills/sanitize.ts`**

Append after the `sanitizeDisplayName` function (after line 306):

```ts
/**
 * Sanitize an object-type skill result by recursively walking its structure
 * and applying sanitizeOutput to each string leaf value.
 *
 * JSON structural characters (keys, braces, brackets, colons) are never
 * passed to the HTML stripper or secret redactor, so they cannot be corrupted.
 * This is the correct approach for sanitizing object-returning skill output —
 * the alternative (stringify → sanitize → parse) corrupts JSON when string values
 * contain HTML, because the sanitizer strips tag characters that happen to be
 * structural JSON characters inside string values.
 *
 * Truncation is applied per string leaf (each string is independently capped at
 * maxLength). isError is excluded — wrapping a structured object in <tool_error>
 * is not meaningful; the execution layer's error path handles that as a string.
 */
export function sanitizeObjectOutput(
  data: unknown,
  options: Omit<SanitizeOptions, 'isError'> = {},
): unknown {
  function walk(node: unknown): unknown {
    if (typeof node === 'string') {
      return sanitizeOutput(node, options);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        result[key] = walk(value);
      }
      return result;
    }
    // Numbers, booleans, null, undefined — pass through unchanged.
    return node;
  }
  return walk(data);
}
```

- [ ] **Step 2: Run the sanitize tests — confirm they all pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object run test tests/unit/skills/sanitize.test.ts
```

Expected: all tests **PASS**, including the new `sanitizeObjectOutput` suite.

- [ ] **Step 3: Run the typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object add src/skills/sanitize.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object commit -m "feat: add sanitizeObjectOutput for structural object sanitization (#986)"
```

---

### Task 3: Write failing tests for execution layer object sanitization

**Files:**
- Modify: `tests/unit/skills/execution.test.ts`

- [ ] **Step 1: Append new tests to `tests/unit/skills/execution.test.ts`**

Open the file. Find the closing `});` of the top-level `describe('ExecutionLayer', ...)` block and insert these tests before it:

```ts
  it('object-returning skill with HTML body values returns valid object (not corrupted string)', async () => {
    const handler: SkillHandler = {
      execute: async () => ({
        success: true,
        data: { messages: [{ body: '<style>x{}</style><div>"quoted"</div>' }] },
      }),
    };
    registry.register(makeManifest(), handler);

    const result = await execution.invoke('test-skill', {});
    expect(result.success).toBe(true);
    if (result.success) {
      // Must be a plain object, never a corrupted string
      expect(typeof result.data).toBe('object');
      const data = result.data as { messages: Array<{ body: string }> };
      expect(Array.isArray(data.messages)).toBe(true);
      expect(typeof data.messages[0]!.body).toBe('string');
      // Dangerous content stripped
      expect(data.messages[0]!.body).not.toContain('<style>');
      expect(data.messages[0]!.body).not.toContain('x{}');
      // Safe content preserved
      expect(data.messages[0]!.body).toContain('"quoted"');
    }
  });

  it('object-returning skill with clean values returns data unchanged', async () => {
    const handler: SkillHandler = {
      execute: async () => ({
        success: true,
        data: { count: 5, label: 'results', items: ['a', 'b'] },
      }),
    };
    registry.register(makeManifest(), handler);

    const result = await execution.invoke('test-skill', {});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { count: number; label: string; items: string[] };
      expect(data.count).toBe(5);
      expect(data.label).toBe('results');
      expect(data.items).toEqual(['a', 'b']);
    }
  });
```

- [ ] **Step 2: Run the execution tests — confirm the new tests fail**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object run test tests/unit/skills/execution.test.ts
```

Expected: the two new tests **FAIL** (execution layer still uses the broken stringify→parse path). All existing tests must still **PASS**.

- [ ] **Step 3: Commit the failing tests**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object add tests/unit/skills/execution.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object commit -m "test: add failing execution-layer tests for object output sanitization (#986)"
```

---

### Task 4: Fix the execution layer

**Files:**
- Modify: `src/skills/execution.ts`

- [ ] **Step 1: Add `sanitizeObjectOutput` to the import**

Find line 24 in `src/skills/execution.ts`:

```ts
import { sanitizeOutput } from './sanitize.js';
```

Change it to:

```ts
import { sanitizeOutput, sanitizeObjectOutput } from './sanitize.js';
```

- [ ] **Step 2: Replace the broken object-sanitization branch**

Find this block (around lines 977–990):

```ts
      } else if (result.success && result.data !== null && result.data !== undefined) {
        const raw = JSON.stringify(result.data);
        const sanitized = sanitizeOutput(raw, { maxLength: this.skillOutputMaxLength, skipSecretRedaction });
        if (raw.length > this.skillOutputMaxLength) {
          skillLogger.warn({ skillName, outputLength: raw.length }, 'Skill output truncated to configured limit');
        }
        try {
          return { success: true, data: JSON.parse(sanitized) };
        } catch (parseErr) {
          // Sanitization truncated the JSON mid-structure — return as string rather
          // than silently dropping the truncation marker.
          skillLogger.warn({ err: parseErr, skillName }, 'Sanitized output is not valid JSON, returning as string');
          return { success: true, data: sanitized };
        }
      }
```

Replace it with:

```ts
      } else if (result.success && result.data !== null && result.data !== undefined) {
        // Sanitize structurally: walk the object and apply tag-stripping + secret
        // redaction to each string leaf. JSON structure is never exposed to the HTML
        // stripper, so it cannot be corrupted. No stringify→parse round-trip needed.
        // Any unexpected throw is caught by the outer try/catch and returned as
        // { success: false } — correct behavior that stops agent retry loops.
        const sanitizedData = sanitizeObjectOutput(result.data, {
          maxLength: this.skillOutputMaxLength,
          skipSecretRedaction,
        });
        return { success: true, data: sanitizedData };
      }
```

- [ ] **Step 3: Run the execution tests — confirm all pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object run test tests/unit/skills/execution.test.ts
```

Expected: all tests **PASS**, including the two new ones.

- [ ] **Step 4: Run the full test suite**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object run test
```

Expected: all tests **PASS**.

- [ ] **Step 5: Run the typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object add src/skills/execution.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object commit -m "fix: sanitize object skill output structurally to prevent JSON corruption (#986)"
```

---

### Task 5: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under `## [Unreleased]`**

Open `CHANGELOG.md`. Under `## [Unreleased]`, add to the `Fixed` section (create it if not present):

```markdown
### Fixed

- **Execution-layer output sanitization** — object-returning skills whose string values contain HTML (e.g. email bodies) no longer produce corrupted JSON. `sanitizeObjectOutput` walks the result structure and sanitizes string leaves directly; JSON structural characters are never exposed to the HTML stripper. Fixes the `ceo-inbox-search` retry loop incident. (#986)
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-fix-986-sanitize-object commit -m "chore: changelog entry for issue #986 sanitize fix"
```
