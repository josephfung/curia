# sent-observe: drain `>SENT_MAX_SCAN` Sent backlogs oldest-first

**Issue:** curia#1431 (part of #1419). **Date:** 2026-07-19.

## Problem

`ceo-inbox-sent-observe` polls the CEO's Sent folder via a single forward
`received_after` watermark floor. Nylas returns messages **newest-first**, so a
window with more than `SENT_MAX_SCAN` (500) unobserved messages yields only the
newest 500. The current, deliberate policy advances the watermark to the newest
message seen and warns that the older tail was skipped — permanently. That is
acceptable at steady state (a day never approaches 500 sends) but means a
**first-run / post-downtime backfill against a large existing mailbox** never
observes the historical tail below the newest 500.

A single forward floor cannot express "drain the oldest messages first," so
draining the tail requires a second, descending bound.

## Decision: forward-only on the first-ever run

On the **first-ever run** (watermark `0`, empty state) the observer does **not**
backfill historical Sent mail. A normal run already advances the watermark to the
newest message seen; on a fresh install there are no draft snapshots, open tasks,
or shadow docs to match, so matching is a near-noop and the watermark simply lands
at the newest existing send — the true forward frontier. We therefore only need to
**not initiate a backfill when `watermark === 0`**. Backfill applies solely to the
**post-downtime** case (a non-zero watermark with a large gap above it).

Rationale: draining the entire Sent history would run many rounds of LLM
shadow-judging against stale mail that has no live drafts/tasks/shadows to match —
wasted work for a forward-looking observer. (Confirmed with the CEO.)

## Mechanism: pinned floor + descending ceiling

Two new `ceo_inbox` config keys (plain integer seconds stored as strings, like the
watermark):

- **`sent_observe.backfill_before`** — a `received_before` ceiling. Its *presence*
  (a finite value) means "a backfill drain is in progress." Descends each run.
- **`sent_observe.backfill_target`** — the newest message date seen when the backlog
  was detected. The watermark jumps to `target + 1` only when the drain completes.

The main watermark (`sent_observe.last_seen_at`) stays **pinned at its original
floor** for the entire drain and doubles as the `received_after` floor for every
backfill scan, so no separate "backfill floor" key is needed.

### Run logic

`advanceOk` gating is unchanged: any evidence-persist / guard-write / shadow-batch
failure still HOLDS all state (no watermark move, no backfill-key move) so the same
window is re-observed next run.

| Mode | Scan window | Truncated | Not truncated (drained) |
|---|---|---|---|
| **Normal** (`backfill_before` unset) | `[watermark, ∞)` | `watermark === 0` → forward-only: advance `watermark = maxDate+1`, **no backfill**. `watermark > 0` → enter backfill: set `target = maxDate`, `backfill_before = minDate`; **do not advance watermark** | advance `watermark = maxDate+1` (unchanged behavior) |
| **Backfill** (`backfill_before` set) | `[watermark, backfill_before]` | descend: `backfill_before = minDate` | drain complete: `watermark = target + 1`, clear both backfill keys |

### Why this is correct

- **No message permanently skipped** (criterion 1): the descending ceiling walks
  the window oldest-ward until a sub-window fits under the ceiling, draining the
  whole `[watermark, target]` range across successive runs.
- **Watermark never advances past an unobserved message** (criterion 2, literal):
  during a drain the watermark stays at the original floor and only jumps to
  `target + 1` once the final (non-truncated) backfill run has observed the oldest
  sub-window. It never sits above an un-drained message.
- **Idempotent re-processing** (criterion 3): `backfill_before = minDate` is
  *inclusive* (Nylas `received_before` is inclusive), so the boundary second is
  re-scanned next run — guaranteeing a same-second group split by the 500 ceiling
  is never lost. The already-matched-draft, asked-task, and shadow `reconciled_at`
  guards make the re-processed boundary (and any held-window retry) a no-op.
- **Progress guarantee:** truncation means messages older than `minDate` exist, so
  the next `[watermark, minDate]` scan yields a strictly older `minDate` (and thus
  a strictly lower ceiling) — unless ≥500 sends share the exact same Unix second,
  which is impossible for one CEO's Sent folder. Documented as a non-issue.

### Worked example (1200 messages `d1 … d1200`, floor `F > 0`, ceiling 500)

1. Normal run, `[F, ∞)` → newest 500 `d701…d1200`, truncated. `target = d1200`,
   `backfill_before = d701`. Watermark stays `F`.
2. Backfill run, `[F, d701]` → `d201…d700`, truncated. `backfill_before = d201`.
3. Backfill run, `[F, d201]` → `d1…d200`, not truncated → drained.
   `watermark = d1200 + 1`, clear both keys.

Every message observed once; watermark jumps only after the entire range is drained.

## Client change

Add `receivedBefore?: number` to `ListMessagesOptions` in `ceo-nylas-client.ts`,
wired into `listMessages` and `listAllMessages`. As with `receivedAfter`, it is sent
only on the first request; Nylas's `next_cursor` carries the filter on later pages.

## Truncation warning (criterion 3 wording)

The warning fires every truncated run until the backlog is drained, reworded so it
no longer claims the tail "will not be revisited":

- `watermark > 0` (backfill active): "backfill in progress — draining oldest-first
  across successive runs," with the current ceiling and remaining floor.
- `watermark === 0` (first run): a distinct notice that historical mail is
  intentionally not backfilled (forward-only observer).

## New mail during a drain

While a multi-run drain is active the ceiling caps scanning below `target`, so mail
sent *after* the backlog was detected is not observed until the drain finishes and
the normal forward poll resumes. This is acceptable for a rare first-run /
post-downtime event and is documented in the handler.

## Testing (TDD)

- Multi-page backlog drains to completion over ≥2 runs with **no** message skipped
  (assert every id is observed across runs).
- Watermark stays pinned during the drain, then jumps to `target + 1` on completion;
  backfill keys cleared.
- Watermark-0 first run: forward-only, advances to newest, **no** backfill keys set.
- A backfill run whose evidence-persist fails holds its window (no key moves).
- Idempotent re-processing across a held-window retry (boundary second re-scan does
  not double-append a diff / double-queue a candidate).
- Client: `receivedBefore` is sent on the first request and not re-sent on cursor
  pages.

## Versioning & changelog

- Patch bump `skills/ceo-inbox-sent-observe/skill.json` (infrastructure resilience
  fix, no new user-facing capability).
- CHANGELOG under **Fixed**.
- No ADR: this refines an existing mechanism within ADR-029, not a new decision.
