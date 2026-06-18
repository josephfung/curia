# Judgment-Driven Auto-Elevation — Work-in-Progress

**Issue:** #951
**Branch:** `feat/auto-elevation-951`
**Plan:** `docs/wip/2026-06-18-judgment-driven-auto-elevation.md`
**Design spec:** `docs/wip/2026-06-18-judgment-driven-auto-elevation-design.md`
**Last updated:** 2026-06-18

---

## Status: 4 of 6 tasks complete

All completed tasks have been reviewed (spec ✅ + quality approved).

| Task | Description | Status | Commits |
|------|-------------|--------|---------|
| 1 | `JUDGMENT_ELEVATION_THRESHOLD` constant + `incrementalUpdate()` returns `Promise<number>` | ✅ complete | `d80b6c9a` |
| 2 | `contact.elevated` bus event (payload, interface, union, factory) | ✅ complete | `9db4de08` |
| 3 | `ContactService.elevateTierToKnown()` — backend interface, Postgres, InMemory, service class, callback | ✅ complete | `01e0d4bd` |
| 4 | Dispatcher Paths 2 + 3 — domain-validated org elevation + judgment elevation in `handleInboundMessage()` | ✅ complete | `5476fe4a` |
| 5 | Dispatcher Path 1 — correspondence elevation in `handleSkillResult()` after `email-reply`/`email-send` | ⏳ pending | — |
| 6 | Wire `index.ts` + `CHANGELOG.md` | ⏳ pending | — |

---

## What's been built

### Task 1 — Threshold constant + pipeline return type

- `src/contacts/confidence-scorer.ts`: exported `JUDGMENT_ELEVATION_THRESHOLD = 0.20`
- `src/contacts/confidence-pipeline.ts`: `incrementalUpdate()` now returns `Promise<number>` (was `Promise<void>`). Early-return paths return `0`; principal contacts return `1.0`; normal path returns `newConfidence`.
- `tests/unit/contacts/confidence-pipeline.test.ts`: added test verifying the return value matches stored `contactConfidence`.

### Task 2 — Bus event

- `src/bus/events.ts`: added `ContactElevatedPayload`, `ContactElevatedEvent`, union member `| ContactElevatedEvent`, and `createContactElevated()` factory — all following existing patterns for `contact.merged` etc.

### Task 3 — ContactService.elevateTierToKnown()

- `src/contacts/types.ts`: `onContactElevated?` added to `ContactServiceOptions`
- `src/contacts/contact-service.ts`:
  - `ContactServiceBackend` interface: `elevateTierToKnown()` method added
  - `PostgresContactBackend`: atomic SQL `WHERE id=$1 AND tier='unknown' AND kind NOT IN ('automated','agent')`
  - `InMemoryContactBackend`: equivalent in-memory guard logic
  - `ContactService`: service method that catches internally (non-throwing), logs at info on success / warn on error, fires `onContactElevated` callback only on success
- 8 unit tests added.

### Task 4 — Dispatcher inbound paths

- `src/dispatch/dispatcher.ts`:
  - Imports `JUDGMENT_ELEVATION_THRESHOLD`
  - `DispatcherConfig`: `contactService?` field added
  - Class: `private contactService?` field, wired in constructor
  - `handleInboundMessage()`: old 4-line confidence block replaced with new 29-line block:
    - **Path 2** (domain-validated): fires immediately when `kind='organization' && tier='unknown'`
    - **Path 3** (judgment): chains after `incrementalUpdate()`, fires when `snapshotTier='unknown' && !isAutomatedKind(snapshotKind) && newConfidence >= 0.20`
  - Both paths are fire-and-forget with `.catch()` — failures never block message handling
- 9 dispatcher unit tests added (4 for Path 2, 5 for Path 3).

---

## What's remaining

### Task 5 — Dispatcher Path 1 (correspondence)

Add to `handleSkillResult()` in `dispatcher.ts`, after the existing reply-lock `if (!matched)` debug block:

```typescript
if (this.contactResolver && this.contactService) {
  const cr = this.contactResolver;
  const cs = this.contactService;
  for (const address of recipients) {
    cr.resolve('email', address)
      .then(ctx => {
        if (ctx.resolved) {
          return cs.elevateTierToKnown(ctx.contactId, 'correspondence');
        }
      })
      .catch(err => this.logger.warn({ err, address }, 'Correspondence elevation failed (non-fatal)'));
  }
}
```

5 unit tests needed (see plan Task 5, Step 1).

### Task 6 — Wire index.ts + CHANGELOG

Three changes to `src/index.ts`:
1. Add `createContactElevated` to the `bus/events.ts` import
2. Add `onContactElevated` callback in the `ContactService.createWithPostgres()` options (publishes `contact.elevated` bus event)
3. Add `contactService` to the `new Dispatcher({...})` config

CHANGELOG entry:
```
- **Auto-elevation** — contacts are automatically promoted from `tier='unknown'` to `tier='known'` via three signal paths: correspondence (outbound email sent to the contact), domain-validated (first inbound from an org-kind contact), and judgment (confidence score crosses the 0.20 threshold). New `contact.elevated` bus event for the audit trail. Automated and agent contacts are excluded at the database layer. (#951)
```

No new unit tests for Task 6 (wiring is validated by typecheck and the Task 5/3/4 tests).

---

## Resuming on another machine

```bash
# From the office-of-the-ceo workspace root:
git -C repos/curia fetch origin
git worktree add worktrees/curia-auto-elevation-951 feat/auto-elevation-951

# Symlink .env
MAIN=/path/to/repos/curia WORKTREE=/path/to/worktrees/curia-auto-elevation-951
ln -sf "$MAIN/.env" "$WORKTREE/.env"

# Install deps
pnpm -C worktrees/curia-auto-elevation-951 install

# Verify state
git -C worktrees/curia-auto-elevation-951 log --oneline
pnpm -C worktrees/curia-auto-elevation-951 run test
```

Then continue with Task 5 (brief in plan, Step 1 = write failing tests for Path 1 correspondence).
