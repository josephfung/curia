# Design: Migrate `meeting-debrief` to the Tasks system (#839)

**Status:** Design, pre-implementation
**Date:** 2026-06-04
**Issue:** [#839](https://github.com/josephfung/curia/issues/839) — Tasks v1 (6/7)
**Companion docs:** [tasks & backlog design](2026-06-01-tasks-and-backlog-design.md) (§7, §9 issue 6), [spec 17 — meeting-debrief](../specs/17-meeting-debrief.md), [spec 07 — scheduler](../specs/07-scheduler.md)

---

## Context

Issue 6 of the Tasks & Backlog v1 rollout is the **proof case** for the abstraction.
The `meeting-debrief` agent currently invents its own task model: three maps
(`pendingDebriefs`, `judgedEvents`, `deferredEvents`) plus a `lastScanTimestamp`
cursor, all persisted into the scheduler job's `progress` JSONB via `scheduler-report`
(spec 17 §3). If the new platform task system can't cleanly absorb this, the
abstraction is wrong and we revisit before building more on top of it.

A key fact discovered during design: **`meeting-debrief` has no TypeScript handler.**
The entire state machine lives in the agent's `system_prompt` in
`agents/meeting-debrief.yaml`. So this migration is a **prompt rewrite**, not a code
refactor. The issue's acceptance criterion "net negative LOC in
`src/agents/meeting-debrief/`" refers to a directory that does not exist; we satisfy
its **intent** — the agent definition gets meaningfully shorter and the bespoke
state-tracking is deleted.

The task system (issues 1–5) has landed on `main`. Two mechanics were verified:

1. A `wake_at` task created by an agent schedules a one-shot `scheduled_jobs` row whose
   `agent_id` is the creating agent. On fire it routes **back to that agent** with
   content `{ task_id, title, progress, task_payload }`. So per-event detail stored in
   the task's `progress` is delivered on wake. The reminder/expiry/scheduled-prompt
   chain can therefore be modelled entirely as wake-ups on one task row.
2. `task-list` returns only `title, tags, status, owner, priority, last_progress_note,
   next_wake_at` — **not** `progress`, `description`, or the calendar `eventId`. The
   design must not depend on reading event identifiers back out of `task-list`.

---

## Decisions (this design supersedes the issue's literal wording where noted)

These were settled with the CEO during brainstorming:

1. **Detection moves from polling to pre-scheduling.** Today the agent fires every 15
   minutes (`*/15 7-22 * * *` ≈ 96 invocations/day), scanning for meetings that just
   ended. Instead it runs **3×/day** (`0 7,12,16 * * *`), scans the rest of the day's
   meetings, judges each, and schedules a debrief task with `wake_at` = the meeting's
   end time. Each debrief then prompts exactly when its meeting ends, via a wake-up.
   - **Rationale:** ~96 → 3 invocations/day; precise prompt timing; leans fully into
     the tasks/wake-up primitive (stronger proof of the abstraction).
   - **Accepted trade-off:** a meeting *added and occurring entirely inside a scan gap*
     (e.g. booked 1pm for 1:30pm with scans at 7/12/16) is missed. Debriefs are
     proactive nice-to-haves, not critical paths; this is acceptable. Cancellations,
     reschedules, and declines of *known* meetings are handled by re-validating the
     event at the prompt wake (we hold the `eventId`).

2. **The scan cursor is dropped entirely.** Under forward-looking scanning
   (now → end of day) deduplicated by a config-store guard, there is no backward window
   to remember. `scheduler-report` is removed from the agent. (This goes further than
   the brainstorming's interim "keep cursor only"; pre-scheduling made the cursor
   obsolete.) The cron's own `next_run_at` is computed from `cron_expr` and does not
   depend on `scheduler-report`.

3. **Judgment is binary YES/NO — DEFER is removed.** Re-judging a meeting yields almost
   no new signal (the calendar entry and enrichment are static), so DEFER mostly
   re-resolved to the same answer while inviting the model to reflexively punt borderline
   calls — pure churn. On a genuine fence the model **leans YES** (an unwanted prompt is
   trivially dismissed; a skipped debrief silently loses takeaways). The underlying
   YES/NO *criteria* in the judgment step are preserved verbatim; only the DEFER output
   option is removed. (The issue marked judgment-logic changes out of scope; collapsing
   3-way → 2-way is a deliberate, owner-approved exception.)

4. **A not-debrief-worthy (NO) meeting creates no task.** Recording a completed task for
   every skipped meeting would flood the backlog with noise (most meetings are NO).
   Instead a lightweight config-store guard marks the event as handled so later daily
   scans don't re-judge it. (This supersedes the issue's "judgment='no' → immediately
   task-complete" wording.)

5. **Consequence of 3 + 4:** there are **no `debrief-judged` tasks at all**. The only
   task tag the agent creates is `debrief-pending` (plus `debrief-followup` children).
   Tasks now *only ever* represent real debrief work.

6. **`owner` flips `curia` → `ceo` across the lifecycle.** `owner` means *who must act
   next* (todo-list semantics), and a debrief task has two phases:
   - **Before the prompt is sent** (scheduled → meeting-end wake): the pending work is
     "Curia must deliver the debrief prompt" → `owner='curia'`.
   - **After the prompt is sent** (awaiting takeaways): the pending work is "the CEO must
     reply" → `owner='ceo'`.

   So at the prompt wake the agent flips `owner` to `ceo`. This also fixes a digest bug:
   creating with `owner='ceo'` would surface a debrief in the CEO's "For you to do"
   *before the meeting ended and before they were ever asked*. With the flip it appears
   in "For you to do" only once actually prompted — which is the AC's intent.

   | Phase | `owner` | `status` | digest section |
   |---|---|---|---|
   | created (scheduled) | `curia` | open | "What I'm working on" |
   | prompted / reminded | `ceo` | open | "For you to do" |
   | CEO replies | — | done | — |
   | expires | — | cancelled | — |

---

## State mapping

| Today (maps in `progress` JSONB) | New |
|---|---|
| `pendingDebriefs[eventId]` | one task: `tag=['debrief-pending']`, `owner` flips `curia`→`ceo` at the prompt wake (see decision 6), `title="Debrief: <meeting>"`. `wake_at` drives the lifecycle (see below). `progress` holds `{ eventId, attendees, scheduledEnd, title, threadId, phase }`. |
| `judgedEvents` (NO) | **no task.** config-store `seen:<eventId>` guard only. |
| `judgedEvents` (defer) | **removed** (DEFER no longer exists). |
| `deferredEvents` | **removed.** |
| `lastScanTimestamp` | **removed** (no cursor; `scheduler-report` dropped). |
| follow-up actions on CEO reply | child tasks, `parent_task_id` = the debrief task, `tag=['debrief-followup']`, `owner` per action. |

### config-store guards (both invisible to the CEO, namespace `debrief`)

- `seen:<eventId>` — **detection dedup.** Set for *every* judged event (YES and NO) so
  the 3 daily scans don't re-judge the same meeting. TTL ~24h (covers the day; the
  meeting ages out of the forward scan window after it occurs).
- `prompted:<eventId>` — **prompt dedup.** The existing layer-2 idempotency guard
  (spec 17 §3.1). Set when the Bullpen prompt actually goes out. Survives task loss and
  prevents duplicate user-facing prompts. **This guard and its `## Step 6` placement are
  pinned by `tests/unit/agent.meeting-debrief-idempotency.test.ts` and must be preserved
  verbatim in structure.**

---

## Operating modes (three)

The agent distinguishes modes by its invocation payload:

- **Scheduled detection** — cron fire, no `task_id` in the payload.
- **Task wake-up** — fired with a `task_id` and the task's `progress` (which carries
  `phase`).
- **Delegated** — invoked by the coordinator via `delegate` (CEO reply or preference
  update).

### Mode 1 — Scheduled detection (`0 7,12,16 * * *`)

1. Read config (`config-store get debrief`) for channel / reminder delay / TTL.
2. `calendar-list-events` from **now → end of day** (CEO timezone), `contactId =
   ${principal_contact_id}`.
3. Filter out: all-day events, solo events (CEO-only / alternate identities),
   cancelled/declined, and any event with a `seen:<eventId>` guard already set.
4. Enrich remaining candidates (`entity-context` per external attendee; `memory-query`
   for stored debrief preferences).
5. **Judge each (binary YES/NO, lean YES on the fence — criteria preserved):**
   - **YES** → `task-create` `{ title:"Debrief: <meeting>", owner:'curia',
     tags:['debrief-pending'], wake_at: <meeting end>, description/progress: event
     metadata + phase:'scheduled' }`. (owner='curia' — the pending work is "Curia must
     prompt"; it flips to 'ceo' at the prompt wake.) Then set `seen:<eventId>`.
   - **NO** → set `seen:<eventId>` only. No task, no prompt.
6. Exit. No `scheduler-report`.

> Note: the prompt is **not** sent at detection time — only the scheduled task is
> created. The prompt is sent later, at the meeting-end wake, after re-validation.

### Mode 2 — Task wake-up (debrief task fires)

Read `progress.phase` from the delivered task context and branch:

- **`scheduled`** (meeting-end wake):
  1. Re-fetch the event by `eventId`. If cancelled / declined / no longer present →
     `task-complete` (note "meeting did not occur"), stop.
  2. Still valid → run the **config-store `prompted:` idempotency guard** then the
     Bullpen post to the coordinator (the pinned `## Step 6` block, unchanged in
     structure: check `prompted:<eventId>` → post → store key with `thread_id` → no
     retry on store failure).
  3. `task-update owner='ceo' wake_at=<now + reminderDelayMinutes>`, set
     `progress.phase='prompted'` (and `promptedAt`, `threadId`). The owner flip moves the
     task into the CEO's "For you to do" now that the ball is in their court.
- **`prompted`** (reminder wake): send one gentle reminder via Bullpen.
  `task-update wake_at=<promptedAt + contextBridgeTtlHours>`, `progress.phase='reminded'`.
- **`reminded`** (expiry wake): `task-update status='cancelled'`
  (note "no CEO response — implicitly declined"). The wake chain ends.

A CEO reply at any point short-circuits this chain (Mode 3 completes the task, which
auto-cancels the pending wake-up).

### Mode 3 — Delegated (CEO reply)

1. **Identify the debrief:** `task-list tag='debrief-pending' owner='ceo' status='open'`,
   match on meeting title / attendee names / context-bridge metadata → get `task_id`.
   If ambiguous, ask the coordinator to clarify.
2. **Parse follow-up actions** from the CEO's notes (unchanged taxonomy: email draft,
   calendar event, KG fact, research delegation, "nothing needed").
3. **Execute — do-now + record:**
   - Curia-doable actions (drafts via `email-draft-save`, bookings via
     `calendar-create-event`, facts via `memory-store`) run **inline this burst**, as
     today. Record each as a **child task** (`parent_task_id`, `tag=['debrief-followup']`)
     created and immediately `task-complete`d.
   - Actions Curia can't do now → **open** child tasks: CEO-only calls → `owner='ceo'`;
     third-party-blocked work → `owner='external'` (+ `waiting_on_contact_id`/`_text`).
     These surface in the digest.
4. **Confirm** to the coordinator (it relays to the CEO), as today.
5. `task-complete` the **parent** debrief task (auto-cancels its pending wake-up).

**Status queries** ("what debriefs are outstanding?") are answered by the
**coordinator's `task-list tag=debrief-pending`** — there is no meeting-debrief
status sub-mode (per the AC; an earlier `debrief-status` skill idea was already
rejected in spec 17).

**Preference updates** (e.g. "don't debrief weekly standups") are unchanged: store a KG
fact via `memory-store`; queried during enrichment (Mode 1 step 4).

---

## Manifest changes (`agents/meeting-debrief.yaml`)

- **Add** to `pinned_skills`: `task-create`, `task-list`, `task-update`, `task-complete`.
- **Remove** from `pinned_skills`: `scheduler-list`, `scheduler-report` (no longer used —
  state lives in tasks + config-store).
- **Keep:** `config-store` (guards), `calendar-list-events`, `calendar-create-event`,
  `calendar-check-conflicts`, `entity-context`, `contact-lookup`, `email-draft-save`,
  `memory-query`, `memory-store`, `bullpen`, `date-resolve`.
- **Change** `schedule.cron`: `*/15 7-22 * * *` → `0 7,12,16 * * *`; update the task
  description to "scan the rest of today's meetings and schedule debriefs".
- **Bump** `version` (minor — new capability surface).

## Documentation changes (in this PR)

- **Rewrite `docs/specs/17-meeting-debrief.md` §3 (State Management)** to describe the
  tasks model: `debrief-pending` tasks, the wake-up lifecycle, the `owner` flip, and the
  two config-store guards (`seen:` / `prompted:`). Update the detection-pipeline section
  to reflect the 3×/day pre-scheduling cadence and binary YES/NO judgment. Keep the
  cross-tick idempotency (`prompted:`) subsection. (Per CEO direction, spec 17 is updated
  here, not punted to a later doc PR.)
- **CHANGELOG.md** — entry under `[Unreleased] → Changed`.

## Follow-ups (separate issues, not this PR)

- **Explicit target `agent_id` on `task-create`** so the coordinator / ceo-inbox can
  schedule wake-ups *into* a specialist (not just self-routing). Includes the
  permission/gating design question (should any agent inject wakes into any other?).
  Draft a new issue.
- *(Optional, low priority)* add `description` to `task-list` output to make single-row
  reads first-class without a `task-get` skill. Not needed for this migration.

---

## Verification

### Existing tests (must pass unmodified)
- `tests/unit/agent.meeting-debrief-idempotency.test.ts` — pins `## Step 6`/`## Step 7`
  headings and the `prompted:` guard ordering (check → post → store → no-retry,
  `thread_id` in value). The redesigned prompt **keeps** Step 6 as the prompt-delivery
  block (now executed at the meeting-end wake) with the guard intact, and a `## Step 7`
  heading immediately after.
- `tests/unit/config.debrief.test.ts` — config loading; unaffected.

### New test
`tests/unit/agent.meeting-debrief-tasks.test.ts` (prompt-structure assertions, same
file-parsing pattern as the idempotency test):
- Three operating modes are present (detection / task wake-up / delegated).
- No references remain to `pendingDebriefs`, `judgedEvents`, `deferredEvents`,
  `lastScanTimestamp`, `scheduler-report`, or `scheduler-list`.
- The four `task-*` skills are pinned; `scheduler-report`/`scheduler-list` are not.
- `schedule.cron` is `0 7,12,16 * * *`.
- Detection creates no task for NO outcomes (guard-only) — asserted by prompt text
  referencing `seen:` and "no task" for the NO branch.

### Other
- `pnpm --prefix <worktree> run typecheck` clean (no `.ts` logic changes expected;
  only the new test file).
- Net-negative LOC in the agent definition (bespoke state-tracking deleted).
- Full suite green.

---

## Out of scope

- The digest "For you to do" rendering (issue 5, already landed) — debrief-pending tasks
  flow into it automatically once their `owner` flips to `ceo`.
- Changes to the `task-*` skill APIs (see Follow-ups).
- Backfill/migration of any in-flight `pendingDebriefs` state in prod. Debriefs are
  short-lived; existing in-flight prompts age out under the old code before/with this
  change. No data migration step.

## Open question (resolve during implementation, non-blocking)

- Confirm dropping the per-tick `scheduler-report` call does not affect the recurring
  cron job's rescheduling or error-budget accounting. Expectation: `next_run_at` is
  derived from `cron_expr`; `scheduler-report` only persisted context + outcome. If it
  turns out to be load-bearing, keep a single minimal `scheduler-report` call with an
  empty context (no cursor) — does not change the state model.
