# Learning subsystem: machine state → config-store JSON (design)

**Issue:** [#1438](https://github.com/josephfung/curia/issues/1438) — part of #1419. Follow-up
from the #1429 simplification review (Tier 4).

## Problem

The email-observation learning subsystem stores two kinds of content in the same OKF markdown
docs:

1. **Prose evidence** — `(draft, sent)` diff bodies, shadow draft text. Document-shaped,
   human-inspectable; OKF is the right home (ADR-029). **Stays.**
2. **Machine state** — queues, statuses, and idempotency guards riding *inside* doc bodies:
   completion candidates + their `status:` lines (`pending-completions.md`), undo/confirm items
   (`completion-digest.md`), the voice proposal's pending/resolved status (`pending-proposals.md`),
   and the already-matched / already-asked guard sets **reconstructed by regexing doc bodies every
   run**.

Every machine-state read is a regex parse; every mutation is a split-blocks-and-rewrite with
optimistic-concurrency retries. The failure mode is silent: a format drift makes a regex stop
matching and an item never surfaces. This class bit three times during #1429 review (the `t1`/`t10`
block-boundary bleed, trimming on any `## ` header, the first-block-only proposal scan).

## Approach

Move the machine state to config-store JSON under the existing `ceo_inbox` namespace (already home
to the watermark, idle-backoff, checkpoint, and dismiss-cooldown keys). **One key per store,
holding a single JSON object, rewritten whole** — removal = writing the map without the entry, so
no per-item tombstones and no per-item status parsing.

`ConfigStore` (`src/memory/config-store.ts`) stores `string` values, so each store is
`JSON.stringify`'d on write and `JSON.parse`'d on read (with a `try/catch` that treats a
missing/garbage record as empty — same posture as the existing `voice_learn.dismissed` JSON key).

### Store mapping

| Config key (`ceo_inbox` ns) | JSON shape | Writer(s) | Reader(s) |
|---|---|---|---|
| `sent_observe.completion_candidates` | `{ [taskId]: { messageId, confidence, reason, sentAt, subject, recipients[], taskTitle } }` | `ceo-inbox-sent-observe` **adds**; `task-completion-from-sent` **removes on consume** | `task-completion-from-sent` |
| `sent_observe.completion_digest` | `{ [taskId]: { kind, taskTitle, note, status } }` | `task-completion-from-sent` **adds**; `resolve-learning-digest` **removes** | `list-learning-digest`, `resolve-learning-digest` |
| `voice_learn.proposal` | `{ status, generated_at, guide } \| null` | `voice-learn` (**supersede**: write replaces prior) | `list-learning-digest`, `resolve-learning-digest` |
| `sent_observe.matched_draft_ids` | `string[]` | `ceo-inbox-sent-observe` | `ceo-inbox-sent-observe` |
| `sent_observe.asked_task_ids` | `string[]` | `ceo-inbox-sent-observe` | `ceo-inbox-sent-observe` |

Digest keys are keyed by `taskId`. The completion queue is keyed by `taskId` too — one open task
has at most one live completion candidate at a time, so keying by task id makes re-adds idempotent
(see atomicity below) and makes "remove on consume" a single-key delete.

### Why `asked_task_ids` is a separate guard (not derived from the queue)

Today the guard is re-derived by regexing candidate headers that **stay** in
`pending-completions.md` after processing (`markCandidateProcessed` only flips the `status:` line;
the block persists until it ages out at 90 days). Once `task-completion-from-sent` **removes**
consumed candidates from the queue map, the map no longer remembers them — so `asked_task_ids`
becomes the standalone persistent guard that stops a consumed task being re-surfaced as a fresh
candidate. Same reasoning for `matched_draft_ids` vs the (staying-OKF) `pending-diffs.md`: it was
regexed out of the diff prose; now stored directly.

### Guard-set retention: bound to live entities

The old guard sets were implicitly bounded — re-derived each run from docs that trim at 90 days.
Standalone JSON arrays would grow forever. Instead, **prune each guard set on write to the entities
that still exist**, both of which `ceo-inbox-sent-observe` already loads every run:

- `asked_task_ids` → intersect with the ids of the currently-open CEO tasks (`openTasks`). A task
  that completes/cancels drops out of the open set and out of the guard. (Re-surfacing a since-
  reopened task is harmless: the original send is already below the watermark; a genuinely new send
  for it is a legitimate new candidate, and `task-completion-from-sent` re-validates eligibility
  before completing.)
- `matched_draft_ids` → intersect with the `draftId`s of the draft snapshots still present
  (`snapshots`). A draft snapshot TTL-sweeps after 7 idle days; once gone it can't be re-matched
  anyway (`matchDraftToSent` only iterates present snapshots), so retaining its id past that is
  pointless. Bound follows the snapshot TTL.

This keeps the "regex-free, stored-directly" win while preserving bounded growth without a new
query — both live sets are already in hand.

### Watermark-hold atomicity (the load-bearing acceptance criterion)

> Guard sets and candidate queues persist only when evidence persistence succeeds (no candidate
> lost, none double-surfaced, across a held-watermark retry).

`ceo-inbox-sent-observe` seeds the guard sets at the **start** of the run and persists new state at
the **end**; the watermark only advances when `advanceOk = evidencePersisted && shadowReconcileOk
&& draftEvidenceComplete`. On a held watermark the run re-observes the same sends next time, so the
new state must be written such that a re-run neither loses nor duplicates a candidate. Ordering:

1. **Prose evidence first** — append `(draft, sent)` diffs to `pending-diffs.md` (stays OKF,
   keeps its append+trim + version-retry). Result feeds `diffsPersisted`.
2. **`completion_candidates`** — merge newly-matched candidates into the map (keyed by taskId) and
   write. This *replaces* the old `pending-completions.md` write and feeds `completionsPersisted`.
3. **`matched_draft_ids`** — write only the drafts whose diff **actually persisted** in step 1
   (coupled to `diffsPersisted`), pruned to present snapshots.
4. **`asked_task_ids`** — write **after** `completion_candidates`, pruned to open tasks.

Failure analysis (config writes are last-write-wins; a hard infra failure throws and is caught):

- Step 2 fails → watermark held (`completionsPersisted` false) → re-run re-matches the task and
  re-adds it to the queue map. Because the map is **keyed by taskId**, the re-add is idempotent:
  no duplicate candidate.
- Step 2 succeeds, step 4 fails → re-run re-matches the task, re-adds to the queue (idempotent) and
  re-adds to `asked_task_ids`. No loss, no double-surface. (Writing candidates *before* the guard
  is what makes the unsafe interleaving — guard says "asked" but queue is empty → candidate lost —
  impossible.)
- Step 1 succeeds, step 3 fails → re-run re-matches the draft (guard didn't stick) and would append
  a **duplicate** diff block. This is cosmetic (one extra diff block feeding the voice LLM), self-
  limiting, and only reachable if the KG dies in the window between two writes to the same store —
  the same residual the OKF version-retry never fully closed either. Acceptable; documented.

### Concurrency trade-off (documented in ADR-029)

Whole-object last-write-wins replaces per-doc optimistic-version checks. Acceptable because each key
has effectively a single writer per cron tick (`ceo-inbox-sent-observe` daily, `task-completion-
from-sent` daily, `voice-learn` weekly, `resolve-learning-digest` interactively on CEO reply) and
they do not run concurrently in prod. The keyed-map + write-ordering above covers the one two-writer
key (`completion_candidates`: add by observe, delete by completion) against interleaving.

## What is deleted vs kept

**Deleted** (the parse/prune/remove machinery, ~300–500 lines incl. tests):

- `skills/_shared/learning-digest.ts`: `parseCompletionDigest`, `parseVoiceGuideProposal`,
  `pruneGuideProposals`, `removeCompletionBlock`, private `guideProposalBlocks` / `guideFromBlock`.
- `skills/_shared/task-completion-risk.ts`: `parseCompletionCandidates` and the
  `formatUndoNote` / `formatConfirmNote` markdown-block formatters (replaced by plain note-string
  composition stored in the digest JSON). Risk logic (`classifyTaskRisk`, `decideCompletionAction`)
  **stays**.
- `skills/_shared/sent-observe-match.ts`: `formatCompletionCandidateBlock` (queue is JSON now).
  `formatDiffBlock`, `trimEvidenceDoc`, matching helpers **stay** (pending-diffs.md is still OKF).
- `skills/ceo-inbox-sent-observe/handler.ts`: `extractMatchedDraftIds`, `extractAskedTaskIds`, and
  the `pending-completions.md` `ensureDoc`/`appendAndTrimDoc` path for the completion queue (the
  diffs path stays).
- `skills/task-completion-from-sent/handler.ts`: `markCandidateProcessed`, `candidateBlock`,
  `appendDigest`'s markdown-append path.
- `skills/voice-learn/handler.ts`: the `## Guide Proposal` block build + `pruneGuideProposals`
  supersede.
- The version-conflict retry loops protecting those specific doc rewrites.

**Kept:**

- `renderVoiceGuideSection` / `renderCompletionSection` in `learning-digest.ts` — now fed from JSON.
- `pending-diffs.md` + `parsePendingDiffs`, per-draft snapshots, shadow docs — unchanged OKF format.
- All config-store watermark / idle-backoff / checkpoint / dismiss-cooldown keys.

## Docs to update (same PR)

- **ADR-029** store-mapping table (L42–48): split the "Cadence / watermarks / guard markers" row so
  queue/status/guard state is explicitly `config-store` JSON; note the last-write-wins trade-off.
- **Spec 19** (L346–347): the fuzzy-candidate guard is config-store state, not a
  `completion_asked:` doc marker.
- **Spec 13** (L376–380): the voice proposal is a config-store object, not a `## Guide Proposal`
  doc block.
- **Spec 04** (L100–101): `pending-diffs.md` stays OKF (no change needed beyond confirming the
  queue moved).

## Sequencing / migration

Land after #1429 (merged 2026-07-17) and deploy **before** enabling the learning subsystem in prod
(it ships disabled in `registry-defaults.yaml`), so there is no live state to migrate; any dev-
instance scratch docs simply TTL out. No migration code.

## Testing (TDD)

New/updated unit tests must cover:

- **Map-rewrite removal** — resolving a digest item writes the map without that entry; other entries
  survive; `t1` vs `t10` can't collide (keys are exact ids, so the old boundary-bleed class is gone).
- **Supersede** — a new voice proposal replaces a still-pending one (single object, not accumulation).
- **Guard-set persistence across a held watermark** — evidence-persist failure holds the watermark
  AND does not strand the guard/queue: a re-run re-matches and re-adds idempotently (no loss, no
  double-surface).
- **Guard-set pruning** — `asked_task_ids` drops ids for now-closed tasks; `matched_draft_ids` drops
  ids for absent snapshots.
- Digest UX unchanged — `list-learning-digest` sections render identically; `approve/dismiss voice`
  and `undo/confirm/dismiss completion` round-trip against the JSON stores.
