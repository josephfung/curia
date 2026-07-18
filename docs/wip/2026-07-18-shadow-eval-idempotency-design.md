# Durable idempotency for shadow reconciliation + replay coverage (#1432)

Status: design approved 2026-07-18
Issue: #1432 (part of #1419). Re-scoped after #1438 landed.

## Problem

Three email-observation write paths were flagged in the #1429 review as non-atomic,
not-durably-idempotent multi-store updates. #1438 subsequently restructured two of them
(the resolve/completion sagas) to be self-healing via idempotent ordering. The remaining
live hazard is the shadow-reconciliation path.

### Item 1 — shadow reconciliation (live at-least-once hazard)

`skills/ceo-inbox-sent-observe/handler.ts` scores each shadow/sent pair by:

1. `actionLogRepo.insert(...)` — a pre-scored `shadow_evaluated` row into `autonomy_action_log`.
2. `workingDocs.update(...)` — a `reconciled_at` marker on the shadow doc.

If step 1 lands but step 2 fails (shadow doc missing at mark time, or a version conflict),
`shadowReconcileOk` flips false, which **holds the watermark**. The carrying Sent message is
therefore re-observed next run; `parseShadowDoc` still returns the shadow (its `reconciled_at`
is unset), so it is **re-judged and re-inserted** — a duplicate `shadow_evaluated` row. The
durable marker is the only idempotency record and it is written *after* the insert, so nothing
guards cross-run replay. The watermark-hold actually *guarantees* the re-run.

### Items 2-3 — already addressed by #1438

- `task-completion-from-sent` — #1438 moved to **digest-first ordering**: undo notes are written
  durably *before* `completeTask`; a second pass completes tasks only after the digest write is
  confirmed; candidate consume-by-delete is gated on that write. A partial failure self-heals
  (task stays active, re-completes idempotently, note overwrites identically).
- `resolve-learning-digest` — mutations are content-idempotent (re-approve writes the identical
  guide, `completeTask` guarded by `status !== 'done'`, `reopenTask` fails loud) and soft-rejects
  are surfaced (`success:false`) so a failed clear leaves the item actionable for retry.

These need **replay tests that prove the acceptance criteria hold**, not new machinery. The
issue's own sequencing note anticipated this re-scope.

## Design

### Part 1 — shadow-reconciliation durable dedup

**Migration `074_shadow_eval_idempotency.sql`**

- **Dedup first, then constrain.** Prod may already hold duplicate `shadow_evaluated` rows
  produced by this bug. A bare `CREATE UNIQUE INDEX` would abort on them (the migration-070
  "detonates only on prod data" hazard). So the Up path first deletes all but the lowest-`id`
  row per `source_message_id`, then creates the index:

  ```sql
  DELETE FROM autonomy_action_log a
  USING autonomy_action_log b
  WHERE a.outcome = 'shadow_evaluated'
    AND b.outcome = 'shadow_evaluated'
    AND a.payload->>'source_message_id' = b.payload->>'source_message_id'
    AND a.payload->>'source_message_id' IS NOT NULL
    AND a.id > b.id;

  CREATE UNIQUE INDEX idx_aal_shadow_source
    ON autonomy_action_log ((payload->>'source_message_id'))
    WHERE outcome = 'shadow_evaluated';
  ```

  - `payload->>'source_message_id'` is immutable, so it is legal in an index expression.
  - The partial predicate scopes the index to shadow rows only — no other outcome/caller can
    ever collide with it.
  - NULL `source_message_id` values are naturally distinct in a Postgres unique index, so the
    dedup DELETE guards `IS NOT NULL` only to avoid collapsing unrelated null-keyed rows (there
    should be none in practice, but the guard is defensive).

- **Down:** `DROP INDEX IF EXISTS idx_aal_shadow_source;` — symmetric, non-aborting (AC #4). The
  dedup DELETE is deliberately not reversed; the deleted rows were erroneous duplicates.

- Mirror migration 073's in-transaction lock note: node-pg-migrate wraps the file in one
  transaction, so no `CREATE INDEX CONCURRENTLY`; the brief lock/scan is acceptable at the
  current single-tenant table size.

**Repo — `src/autonomy/action-log-repo.ts`**

Add `insertShadowEvaluated(row: ActionLogInsert): Promise<number | null>`:

- Same column list as `insert()` but with
  `ON CONFLICT ((payload->>'source_message_id')) WHERE outcome = 'shadow_evaluated' DO NOTHING
  RETURNING id`.
- Returns the new `id`, or `null` when the row already existed (conflict).
- Factor the shared INSERT column list / VALUES tuple into a private helper so the two insert
  paths cannot drift.
- `insert()` keeps its `Promise<number>` signature and current behavior — no non-shadow caller
  is affected.

**Handler — `skills/ceo-inbox-sent-observe/handler.ts`**

- Swap `ctx.actionLogRepo.insert(...)` → `ctx.actionLogRepo.insertShadowEvaluated(...)` in the
  per-pair reconcile loop.
- A `null` return means "already scored on a prior run" — **not** an error. Proceed to mark
  `reconciled_at` so the re-run converges and stops re-observing. Only a thrown error flips
  `shadowReconcileOk` false / holds the watermark, as today.
- `reconciled_at` + the watermark-hold remain the **efficiency** guard (skip re-judging, avoid
  LLM cost); the DB constraint is the new **correctness** backstop.
- Count `shadowReconciled` on a successful `reconciled_at` mark (covers both fresh-insert and
  converging-after-a-prior-partial-failure), so the stat reflects "reconciled this run".
- Update the loop comments to state the constraint is now the durable idempotency record.

### Part 2 — resolve & completion replay coverage

Audit both `handler.test.ts` files, then add the missing replay tests:

- **`resolve-learning-digest`** — for each action (`approve_voice`, `dismiss_voice`,
  `undo_completion`, `confirm_completion`, `dismiss_completion`): the clear write
  (`writeVoiceProposal` / `writeCompletionDigest`) soft-rejects (`false`) on the first attempt,
  then the action is replayed. Assert: the primary mutation is not harmfully double-applied and
  the state converges on retry.
- **`task-completion-from-sent`** —
  (a) digest write soft-rejects → nothing completed, nothing consumed, all candidates retry;
  (b) `completeTask` throws after the digest write lands → candidate retained, undo note durable,
      self-heals on the next run (re-complete is idempotent);
  (c) a clean replay after a successful run → candidates consumed, no re-completion.

If any test surfaces a genuine residual gap, fix it minimally (and version-bump that skill).
The expectation is that most pass, demonstrating #1438 closed items 2-3.

## Housekeeping

- Patch-bump `skills/ceo-inbox-sent-observe/skill.json` (fix that adds infrastructure).
- No version bump for the two verification-only skills unless a residual fix lands.
- `CHANGELOG.md` → `Fixed` entry.
- No ADR (bug fix under existing ADR-029; existing-pattern migration).

## Acceptance criteria (from #1432)

- [ ] Re-running shadow reconciliation after a marker-write failure does not create a second
      `shadow_evaluated` row for the same shadow.
- [ ] Replaying a `resolve-learning-digest` action after a mid-saga failure does not double-apply
      the profile/config/task mutation.
- [ ] Replaying `task-completion-from-sent` after a partial write reconciles to a consistent state.
- [ ] Migration has a symmetric, non-aborting down path.
- [ ] Unit/integration tests cover each replay scenario.
