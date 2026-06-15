# Design: Execution-layer structural output sanitization (issue #986)

**Date:** 2026-06-15
**Issue:** [#986](https://github.com/josephfung/curia/issues/986)
**Status:** Approved, pending implementation

---

## Problem

`ExecutionLayer.invoke` sanitizes object-returning skill results with a
stringify→mutate→reparse round-trip:

```
JSON.stringify(result.data)       // object → flat string
sanitizeOutput(raw, { maxLength }) // HTML stripper mutates the string
JSON.parse(sanitized)             // throws when structural chars were removed
```

`sanitizeOutput` runs an HTML parser over the *entire serialized JSON document*.
When a string value inside the document contains an HTML tag
(`<style>`, `<script>`, `<div>`, etc.), the parser strips the tag — along with
any structural JSON characters that happen to be inside it (quotes, braces).
The resulting string is no longer valid JSON. On parse failure, the execution
layer returned the corrupted string as `{ success: true, data: corruptedString }`,
which agents could not use, triggering retry loops.

Observed in prod (2026-06-15): `ceo-inbox-search` returns Nylas message objects
whose `body` field is HTML. The sanitizer mangled the serialized JSON →
`SyntaxError: Unterminated string in JSON at position 2756`. The `ceo-inbox`
agent received corrupted output, could not parse it, and re-ran the skill 8+
times before the 120s request window closed.

---

## Root cause

`sanitizeOutput` is a *string-level* transform. It has no awareness of JSON
structure. Applying it to a serialized JSON document is safe only if every
string value in that document contains no HTML markup — a guarantee that cannot
be made for email bodies or any other user-generated rich text.

---

## Fix

Sanitize *structurally*: walk the object, apply `sanitizeOutput` to each string
leaf value, and return the sanitized object. JSON keys and structural characters
are never exposed to the HTML stripper or secret redactor.

---

## Architecture

### New function: `sanitizeObjectOutput` in `src/skills/sanitize.ts`

```ts
export function sanitizeObjectOutput(
  data: unknown,
  options: Omit<SanitizeOptions, 'isError'> = {},
): unknown
```

**Walker behaviour by node type:**

| Node type | Action |
|---|---|
| `string` | Call `sanitizeOutput(leaf, options)` — tag-strip, redact, truncate per-value |
| `Array` | Map each element through the walker recursively |
| Plain `object` | Map each value through the walker; keys are not sanitized |
| `number` / `boolean` / `null` / `undefined` | Returned as-is |

`isError` is excluded from the options type — wrapping a structured object in
`<tool_error>` tags is not meaningful. The execution layer's error path is
handled separately as a string.

**Truncation:** `maxLength` from `SanitizeOptions` is applied *per string leaf
value*. Each individual string is independently capped. This is simpler and less
error-prone than a shared budget, and matches the existing per-string behaviour
of `sanitizeOutput`.

**Reuse:** The walker calls the existing `sanitizeOutput` for each leaf, which
already handles tag-stripping, secret redaction, `skipSecretRedaction`, and
`extraRedactPatterns` in the correct order. No logic is duplicated.

### Changes to `src/skills/execution.ts`

The object-result branch (lines 977–990) is replaced:

**Before (broken):**
```ts
const raw = JSON.stringify(result.data);
const sanitized = sanitizeOutput(raw, { maxLength, skipSecretRedaction });
try {
  return { success: true, data: JSON.parse(sanitized) };
} catch (parseErr) {
  skillLogger.warn(...);
  return { success: true, data: sanitized }; // returns corrupted string
}
```

**After (fixed):**
```ts
const sanitizedData = sanitizeObjectOutput(result.data, {
  maxLength: this.skillOutputMaxLength,
  skipSecretRedaction,
});
return { success: true, data: sanitizedData };
```

The `try/catch` parse-failure branch is removed entirely. Any unexpected throw
from `sanitizeObjectOutput` (e.g., circular reference in skill output) is caught
by the outer `try/catch` already wrapping `invoke`, which returns
`{ success: false, error: ... }` — correct behavior that stops agent retries.

---

## Security properties preserved

- Dangerous HTML/XML tags (`<script>`, `<style>`, `<system>`, etc.) are still
  stripped from all string values.
- Secrets matching `SECRET_PATTERNS` are still redacted from all string values.
- `skipSecretRedaction` and `extraRedactPatterns` are forwarded to the leaf
  sanitizer unchanged.
- `maxLength` truncation still applies, per string leaf value.
- Tag-stripping still uses `sanitize-html` (library parser, not regex), so
  ReDoS and bad-tag-filter protections are inherited.

---

## Files changed

| File | Change |
|---|---|
| `src/skills/sanitize.ts` | Add `sanitizeObjectOutput` export |
| `src/skills/execution.ts` | Replace stringify→sanitize→parse branch with `sanitizeObjectOutput` call |
| `tests/unit/skills/sanitize.test.ts` | Add `sanitizeObjectOutput` test suite |
| `tests/unit/skills/execution.test.ts` | Add object-result sanitization tests |

---

## Test plan

### `sanitizeObjectOutput` unit tests

- Passes plain objects with no HTML or secrets through unchanged
- Strips dangerous HTML tags from string leaf values; object structure preserved
- Redacts secrets from string leaf values
- Preserves non-string leaf values (numbers, booleans, null, arrays, nested objects)
- `maxLength` truncates each string leaf independently; adjacent short values unaffected
- `skipSecretRedaction` forwarded correctly to leaf sanitizer
- **Regression (from AC):** `{ messages: [{ body: '<style>x{}</style><div>"quoted"</div>' }] }`
  → valid object; `body` is a string with dangerous content removed; JSON structure intact

### `ExecutionLayer` integration tests

- Object-returning skill whose values contain HTML returns `{ success: true, data: <object> }`
  where `data` is a valid object (not a string)
- Dangerous tags are stripped from string values inside the returned object
- Existing string-returning skill tests pass unchanged

---

## Acceptance criteria (from issue)

- [ ] An object-returning skill whose values contain HTML / `<…>` / secret-shaped content
      sanitizes to a valid object, not a mangled string
- [ ] Dangerous tags inside string values are stripped; secrets are redacted
- [ ] `ceo-inbox-search` over messages with HTML bodies returns parseable structured data
- [ ] Regression test passes: `{ messages: [{ body: '<style>x{}</style><div>"quoted"</div>' }] }`
      round-trips to a valid object with the dangerous tag removed
- [ ] If the execution layer encounters an unexpected error during sanitization,
      it returns `{ success: false }` — not corrupted data as `success: true`
