# Task 1 Report: Re-derivation one-shot script

## What was implemented

Added `scripts/rederive-contact-tiers.ts`: a one-shot backfill script that:
1. Calls `ConfidencePipeline.fullRecomputeAll()` to refresh all contact confidence scores from stored correspondence stats.
2. Lists all `tier='unknown'` person/org contacts via `ContactService.listContacts({ tier: 'unknown', kind: ['person', 'organization'] })`.
3. For each candidate, calls `pipeline.fullRecompute(id)` again to get the authoritative post-recompute value.
4. Elevates contacts clearing `JUDGMENT_ELEVATION_THRESHOLD` via `contactService.elevateTierToKnown(id, 'judgment')`.
5. Returns `{ recomputed, elevated, skipped, errors, failedContactIds }`.

Exports `runRederive(contactService, pipeline)` for testing with minimal mocks (Pick<> aliases). CLI entry point wires real `pg.Pool`, `ContactService.createWithPostgres(pool, undefined, logger)`, and `new ConfidencePipeline(contactService, logger)`.

Also added:
- `scripts/rederive-contact-tiers.test.ts` — verbatim from brief
- `package.json`: `"rederive:contact-tiers": "tsx --env-file=.env scripts/rederive-contact-tiers.ts"` next to `backfill:contact-attributes`
- `CHANGELOG.md`: Added entry under `[Unreleased]`

## TDD Evidence

### RED — test fails before implementation

```
pnpm -C <worktree> exec vitest run scripts/rederive-contact-tiers.test.ts
FAIL scripts/rederive-contact-tiers.test.ts
Error: Cannot find module './rederive-contact-tiers.js'
Test Files  1 failed (1)
Tests  no tests
```

### GREEN — test passes after implementation

```
pnpm -C <worktree> exec vitest run scripts/rederive-contact-tiers.test.ts
{"level":30,...,"recomputed":2,"elevated":1,"skipped":1,"errors":0,...,"msg":"rederive: done"}
Test Files  1 passed (1)
Tests  1 passed (1)
Duration 338ms
```

## Typecheck

```
pnpm -C <worktree> run typecheck
$ tsc --noEmit
(no output — clean)
```

## Files changed

- `scripts/rederive-contact-tiers.ts` (new, 100 lines)
- `scripts/rederive-contact-tiers.test.ts` (new, 33 lines)
- `package.json` (1 line added — `rederive:contact-tiers` script)
- `CHANGELOG.md` (3 lines added)

## Commit

`1241c9bf` — `feat: add one-shot contact-tier re-derivation script (#955)`

## Self-review findings

- `fullRecomputeAll()` returns `Promise<number>` (count), not `Promise<undefined>` as the brief comment implied; the mock uses `mockResolvedValue(undefined)` which resolves fine since we don't use the return value — no adaptation needed.
- The per-candidate `fullRecompute(id)` call is technically redundant since `fullRecomputeAll()` already persisted fresh scores, but it's load-bearing: the listed snapshot's `contactConfidence` field is the old value (pre-recompute) from the SQL query, so we need the re-call to get the authoritative post-recompute value. This matches the brief's intent and is documented in code comments.
- No `any`, no console.log, no interpolated SQL. Pino only. `.js` extensions on all relative imports.

## Concerns

None. Implementation is straightforward and matches brief exactly.

---

## Review Fix Report (post-review pass)

### Changes made

1. **CHANGELOG.md** — merged the two consecutive `### Added` headings under `## [Unreleased]` into one. The Task-1 `rederive:contact-tiers` bullet was prepended as a separate block; it is now the first bullet under the single unified `### Added` section.

2. **`scripts/rederive-contact-tiers.ts`** — captured the `Promise<number>` return value of `pipeline.fullRecomputeAll()` into `const recomputed` and used that in the summary instead of `candidates.length`. `fullRecomputeAll` returns the count of all contacts it processed (confirmed in `src/contacts/confidence-pipeline.ts` line 146: `async fullRecomputeAll(): Promise<number>`), so the field now accurately reflects total contacts recomputed rather than just unknown-tier candidates.

3. **`scripts/rederive-contact-tiers.test.ts`** — updated `fullRecomputeAll` mock from `mockResolvedValue(undefined)` to `mockResolvedValue(2)` (total contact count). Added two assertions: `expect(result.recomputed).toBe(2)` and `expect(result.skipped).toBe(1)` (contact 'b' is below threshold).

### Test run

```
pnpm -C <worktree> exec vitest run scripts/rederive-contact-tiers.test.ts
{"recomputed":2,"elevated":1,"skipped":1,"errors":0,"failedContactIds":[],"msg":"rederive: done"}
Test Files  1 passed (1)
Tests  1 passed (1)
Duration 448ms
```

### Typecheck

```
pnpm -C <worktree> run typecheck
$ tsc --noEmit
(no output — clean)
```

### Commit

See git log for SHA — message: `fix: address Task 1 review (changelog heading, recomputed count, test assertions) (#955)`
