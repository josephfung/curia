# 19 — Tasks & Backlog

**Date:** 2026-06-04
**Status:** Shipped (v0.33)

## Overview

Curia is good at acting on a single request but historically lost fidelity across
sessions because there was no canonical place to track work. The Tasks system gives
the platform a shared primitive for deferred, multi-step, and waiting work: a single
`tasks` table, four `task-*` skills, a deterministic hourly heartbeat that keeps open
work moving, and a CEO-visible backlog surfaced through the daily digest.

It addresses four recurring failure modes:

1. **No ownership distinction.** "I should do this" vs. "the CEO should do this" vs.
   "we're waiting on someone else" were all rendered the same way. Tasks make the
   three-way split first-class.
2. **No persistence for larger projects.** Multi-step work either crammed into one
   burst or fell on the floor between bursts. Tasks let an agent decompose a project,
   advance what it can, and park the rest behind a wake condition.
3. **Bursty specialists.** When `meeting-debrief` or `ceo-inbox` uncovered seven
   follow-ups, the only options were "do all now" or "drop them." Deferral into a
   queryable backlog replaces the explosion.
4. **Everything treated as urgent.** A `priority` signal lets work be ranked rather
   than competing for the same immediate attention.

The design leans on infrastructure that already existed: the Postgres-backed scheduler
([spec 07](07-scheduler.md)), the daily `pending-actions-digest`, the autonomy engine
([spec 14](14-autonomy-engine.md)), and the audit trail.

**Companion design docs** (the dated record of how this was designed and sequenced):
[2026-06-01-tasks-and-backlog-design.md](../wip/2026-06-01-tasks-and-backlog-design.md),
[2026-06-03-digest-backlog-sections-design.md](../wip/2026-06-03-digest-backlog-sections-design.md),
[2026-06-04-meeting-debrief-tasks-migration-design.md](../wip/2026-06-04-meeting-debrief-tasks-migration-design.md),
[2026-06-04-task-execution-heartbeat-design.md](../wip/2026-06-04-task-execution-heartbeat-design.md).

---

## 1. Architecture Summary

- **One table.** The pre-existing `agent_tasks` table was renamed and promoted to
  `tasks` with CEO-visible columns. There is no parallel table; existing scheduler and
  persistent-task callers continued to work after a mechanical rename plus one column
  migration (§2).
- **Four skills.** `task-create`, `task-list`, `task-update`, `task-complete` — granular
  domain skills matching the existing `calendar-*` / `ceo-inbox-*` pattern.
- **No new specialist agent.** Task management is a platform-level capability available
  to any agent (like memory), gated by the `enable_task_management` flag (§4).
- **Three reactivation channels drain the backlog** (§5): an inbound event, a per-task
  `wake_at` timer, and the deterministic `BacklogHeartbeat` backstop.

### 1.1 Scheduler ↔ Tasks relationship

The single most important architectural decision is the split between *when* and *what*:

- **`scheduled_jobs` owns "when."** Cron and one-shot triggers, polled every 30s. No new
  polling logic was introduced.
- **`tasks` owns "what."** Units of CEO-visible work. The tasks table is *unaware of
  scheduling* — no `next_attempt_at`, no `scheduled_job_id`.
- **The bridge is a one-way forward FK, `scheduled_jobs.task_id → tasks.id`.** Most
  `scheduled_jobs` rows have `task_id = NULL` (digests, cron-driven agents). A task-bound
  row exists only when something asked to wake a specific task at a specific time. The
  scheduler reads only `scheduled_jobs`, never `tasks`.

The old back-FK (`agent_tasks.scheduled_job_id`, from [spec 07](07-scheduler.md)) was
dropped in the migration; the forward direction replaces it and additionally answers the
more frequent question — "which task does this firing job belong to?" — without a second
query path. `due_at` on a task is a CEO-facing deliverable date, **not** a wake-up
trigger; a wake-up is always a `scheduled_jobs` row, so the two are never double-stored.

### 1.2 `owner` vs. `source_agent_id`

Two distinct concepts that an earlier draft conflated:

- **`owner`** — `'curia' | 'ceo' | 'external'`. CEO-visible. Drives the digest's
  three-way grouping ("what should I do" vs. "what is Curia doing" vs. "what are we
  waiting on").
- **`source_agent_id`** — internal routing. The specialist that created the task and is
  best positioned to resume it (`'meeting-debrief'`, `'ceo-inbox'`, …); may be null for
  CEO-created tasks. A wake-up routes here (falling back to the coordinator).

The two questions never consult the same field.

---

## 2. Data Model

Migration [`049_promote_agent_tasks_to_tasks.sql`](../../src/db/migrations/049_promote_agent_tasks_to_tasks.sql)
renames `agent_tasks → tasks`, adds CEO-visible columns, drops the back-FK, and adds the
forward `scheduled_jobs.task_id`. Canonical contact-attribute columns landed in the
adjacent migration `048_add_contact_canonical_attributes.sql` (see [spec 09](09-contacts-and-identity.md)).

### 2.1 Columns added to `tasks`

| Column | Type | Notes |
|---|---|---|
| `title` | `TEXT NOT NULL DEFAULT ''` | CEO-visible. Backfilled from `LEFT(intent_anchor, 255)` for pre-existing rows. |
| `description` | `TEXT` | Optional longer detail. |
| `owner` | `TEXT NOT NULL DEFAULT 'curia'` | `CHECK IN ('curia','ceo','external')`. |
| `priority` | `INTEGER NOT NULL DEFAULT 50` | Higher = more urgent. Drives sort order. |
| `due_at` | `TIMESTAMPTZ` | CEO-facing deliverable date; **not** a wake-up. |
| `source` | `TEXT NOT NULL DEFAULT 'agent'` | `CHECK IN ('ceo','agent','scheduler','coordinator')`. |
| `source_agent_id` | `TEXT` | Which agent can resume this task; backfilled from `agent_id`. |
| `created_by` | `TEXT NOT NULL DEFAULT 'system'` | |
| `parent_task_id` | `UUID REFERENCES tasks(id)` | Subtask linkage for projects. |
| `blocked_by_task_id` | `UUID REFERENCES tasks(id)` | Single-dependency ordering. |
| `waiting_on_contact_id` | `UUID REFERENCES contacts(id)` | Preferred way to record "waiting on a person." |
| `waiting_on_text` | `TEXT` | Soft alternative when no contact row exists yet. |
| `tags` | `TEXT[] NOT NULL DEFAULT '{}'` | Lightweight clustering (`'debrief-pending'`, `'inbox-overflow'`) without a goals entity. |

Preserved verbatim from `agent_tasks`: `intent_anchor` (durable goal statement),
`progress` JSONB (multi-burst execution state), `error_budget`, `conversation_id`,
`agent_id`, timestamps.

### 2.2 Status lifecycle

The status `CHECK` constraint carries **both** the new task-lifecycle values and the
legacy scheduler values, so scheduler code that predates the task skills keeps working:

- **Task lifecycle:** `open`, `in_progress`, `blocked`, `waiting`, `done`, `cancelled`.
- **Legacy (scheduler):** `active`, `pending`, `paused`, `completed`, `failed`.

`waiting` vs. `blocked`: *waiting* = something outside Curia must happen (a person, a
date, a third-party system); *blocked* = another known task must complete first.

### 2.3 Indexes

- `tasks_open_priority_idx` on `(priority DESC, due_at NULLS LAST) WHERE status IN ('open','in_progress')` — heartbeat and digest queries.
- `tasks_parent_idx` on `(parent_task_id) WHERE parent_task_id IS NOT NULL` — subtask queries.
- `scheduled_jobs_task_idx` on `(task_id) WHERE task_id IS NOT NULL` — wake-up routing.

---

## 3. Skills

Four skills under `skills/`, each with an explicit `action_risk` per
[CLAUDE.md](../../CLAUDE.md). Emit `task.created` / `task.updated` / `task.completed`
bus events for audit and future subscribers.

| Skill | `action_risk` | Notes |
|---|---|---|
| `task-create` | `low` | Auto-fills `source` / `source_agent_id` from caller context. `wake_at` is a convenience arg: when set, the skill creates the task **and** a one-shot `scheduled_jobs` row (with `task_id`) in one transaction. The wake time lives on the schedule row, not the task. |
| `task-list` | `none` | Default sort `priority DESC, due_at ASC NULLS LAST`. Returns title, status, owner, due_at, age, last progress note, and the next pending wake-up if any. Timestamps via `toLocalIso()`. |
| `task-update` | `low` | Appends `progress_note` to `progress`. Setting `wake_at` cancels any existing pending wake and creates a fresh one-shot. Status transitions validated (`done → open` rejected). Completing/cancelling auto-cancels pending `scheduled_jobs` rows where `task_id = ?`. |
| `task-complete` | `low` | Sets `status='done'`, captures the note in audit + progress, auto-cancels pending wake-ups. A separate skill so the coordinator prompt can reason about completion cleanly and the audit log distinguishes completion from a generic update. |

Cancellation is `status='cancelled'` (no `task-delete`, to preserve the audit trail).
Single-row reads use `task-list` with a filter (no `task-get`). The skills are pinned to
participating agents via `enable_task_management` (§4).

---

## 4. The `enable_task_management` Capability

The executor discipline (§6) is behavioral; hand-injecting it into each agent prompt
would drift the moment someone hand-builds a custom agent. Instead a single declarative
flag on the agent YAML bundles the whole capability:

```yaml
# agents/<name>.yaml
enable_task_management: true   # default: false
```

When `true`, the agent runtime does three things:

1. **Auto-pins** `task-create`, `task-list`, `task-update`, `task-complete` (merged and
   deduped with the agent's explicit `pinned_skills`).
2. **Auto-injects** the single `task_management` guidance block (§6) at a fixed slot in
   the effective system prompt (after the identity / security blocks). A fixed slot, not
   a `${placeholder}` — for a discipline block, "flag set but author forgot the
   placeholder" would reintroduce exactly the inconsistency this eliminates.
3. **Marks the agent heartbeat-eligible** — only enabled agents appear in the heartbeat's
   `source_agent_id` allow-list (§5).

Shipped enabled on **`coordinator`** and **`ceo-inbox`**. The coordinator drops its
now-redundant manual `task-*` pins and gains a bounded `error_budget` for project bursts.
An agent may still list individual `task-*` skills in `pinned_skills` *without* the flag
for a bespoke need (e.g. read-only `task-list`) — that agent is not heartbeat-eligible and
gets no injected block. If a task's `source_agent_id` points at a non-enabled or null
agent, the heartbeat routes the wake to the coordinator.

The `task_management` block is platform code, versioned with the platform, so every
opted-in agent gets the identical current rules.

---

## 5. The BacklogHeartbeat

`BacklogHeartbeat` ([src/scheduler/backlog-heartbeat.ts](../../src/scheduler/backlog-heartbeat.ts))
is a System-layer component started in `src/index.ts` with its own hourly tick. It runs
one deterministic selection query over `tasks` and inserts one-shot `scheduled_jobs` wake
rows. **It performs no LLM work and no domain reasoning** — it is the conductor, never an
instrument. This preserves the scheduler's invariant (it reads only `scheduled_jobs`); the
heartbeat is a separate component that reads `tasks` and *produces* `scheduled_jobs` rows,
reusing the entire existing dispatch path.

It replaces the never-built 3×/day LLM `backlog-sweep` from the original design, which
conflated routing with doing and was itself a recurring burst of action.

### 5.1 Reactivation model

A parked task returns to life through three layers, fastest to slowest:

1. **Event (instant).** An inbound reply or provided document wakes the blocked task via
   the existing `context-bridge` mechanism. This is the primary driver for in-flight work.
2. **Per-task `wake_at` (precise).** Set by the owner when parking; stored as a one-shot
   `scheduled_jobs` row. Cancelled if the event fires first.
3. **Heartbeat (catch-all).** The backstop for when an agent forgot to set a wake or a
   task got orphaned. This is what guarantees nothing lingers.

### 5.2 Selection: pick the agent, not the task

The heartbeat wakes an **agent**, not a task. Per tick, for each eligible
`source_agent_id` it selects that agent's single most-deserving entry-point task and
enqueues exactly one wake. Two protections against over-waking stack:

- **`blocked_by` keeps ordered chains out of the candidate set** — successors are excluded
  until their blocker is `done`/`cancelled`, so only a chain's head is ever a candidate.
- **One wake per agent per tick** — the woken agent pulls its own `task-list` and advances
  several of its ready tasks in that burst, in the order it knows, bounded by its
  `error_budget`.

A global cap (`heartbeatMaxWakesPerTick`, default 5) backstops the case where many agents
have idle work. Two candidate populations:

| Population | Predicate | On wake, the owner… |
|---|---|---|
| **Idle-unblocked** | `owner='curia'`, `status IN ('open','in_progress')`, unblocked, no pending/running wake, `updated_at` older than `idleThresholdHours` (default 4h) | advances the work |
| **Orphaned wait** | `owner='curia'`, `status IN ('waiting','blocked')`, `waiting_on_contact_id IS NULL`, no pending/running wake, `updated_at` older than `staleWaitThresholdHours` (default 48h) | re-evaluates: escalate, or re-park with a proper `wake_at` |

Both populations are scoped to `owner='curia'` — the heartbeat never chases work the CEO or
an external party owns. The orphaned-wait path additionally requires `waiting_on_contact_id
IS NULL`: a task explicitly waiting on a specific person is **excluded entirely**, not merely
delayed, so the heartbeat never re-pings a human (that nudge is the owner's job via a
`wake_at`). The two thresholds differ deliberately — poke an in-flight task within half a
workday, but give a forgotten timer 48h before the backstop fires.

---

## 6. The Executor Loop & No-Dangling-Commitment Invariant

These behavioral rules live once in the injected `task_management` block, applied
uniformly to every participating agent.

**The loop:** when an agent receives or resumes a task it (1) *advances until blocked* —
does every step it can now, stopping only at a genuine blocker (a person, the CEO's
approval, a future date, a prior task) or when its burst budget runs low; (2) *reifies
before it promises*; (3) *parks cleanly* — sets status, appends a progress note, and sets
a wake (an event bridge or a `wake_at`).

**The invariant:**

> No outbound artifact may contain an unfulfilled forward commitment unless a task backs
> that commitment — and the agent prefers to fulfill the commitment *before* sending.

This kills the dangling-document failure (an agent promising "the CEO will follow up with
the document" with nothing tracking the promise). The reply step is `blocked_by` the
obtain-document step, so the default behavior is to resolve first and send a complete
reply. The three runtime outcomes — resolve-then-reply (preferred), promise-then-self-
fulfill, promise-then-CEO-owns-plus-notify (fallback) — are chosen by the agent at runtime;
*how hard Curia tries before falling back* is governed by the autonomy posture (§8), not
new logic.

### 6.1 Project decomposition

> If work has more than one step, or any step cannot be done right now, create a parent
> task (`intent_anchor` = the durable goal) plus the first wave of subtasks
> (`parent_task_id`, with `blocked_by_task_id` for ordering). Otherwise, a single task.

Plan the first wave only and add subtasks as reality reveals them. For a project spanning
specialists, the coordinator owns the parent and subtasks may carry different
`source_agent_id`s so each wakes the right owner. The parent is itself heartbeat-eligible,
so once its children are done the heartbeat wakes its owner to close it out — no special
parent-rollup machinery in v1.

---

## 7. CEO Visibility: Digest Sections

`pending-actions-digest` (daily) gained three backlog sections after the existing
approvals block, each rendered only when non-empty and capped at 5 with a `+N more` footer:

- **For you to do** — `owner='ceo'`, status `open`/`in_progress`, top 5 by priority.
- **Waiting on others** — `owner='external'`, `status='waiting'`; resolves
  `waiting_on_contact_id` to a display name, falling back to `waiting_on_text`.
- **What I'm working on** — `owner='curia'`, status `open`/`in_progress`, top 5 by priority.

This reuses the existing digest the CEO already reads; no parallel digest or new channel
was introduced. Interactive controls (snooze / done / reassign) are explicitly deferred.

---

## 8. Integrations

- **Per-task wake routing** ([spec 07](07-scheduler.md)). The scheduler dispatch step
  branches on `scheduled_jobs.task_id`: when set, it loads the task and routes the fire to
  `source_agent_id` (falling back to the coordinator), passing `task_id`, `title`,
  `intent_anchor`, and `progress` as context. The polling loop, retry logic, and
  error-budget accounting are untouched.
- **`meeting-debrief`** ([spec 17](17-meeting-debrief.md)) was the proof case: its bespoke
  `pendingDebriefs` / `judgedEvents` state maps were deleted in favor of platform tasks
  (`tag='debrief-pending'`, per-meeting wake-ups). Pending debriefs now appear in the
  digest's "For you to do."
- **`ceo-inbox`** joins the system (`enable_task_management: true`): reification in the
  NEEDS DRAFT path prevents bare forward commitments; resume mode drafts the complete reply
  when a deferred follow-up task wakes; overflow load-shedding above ~10 unread defers the
  tail as `tag='inbox-overflow'` tasks so per-burst LLM time no longer scales linearly.
- **Autonomy** ([spec 14](14-autonomy-engine.md)). The "execute the safe stuff, escalate
  the rest" behavior is the existing autonomy engine — `action_risk` per skill against the
  live score. Drafting (low) just happens; outbound (medium) is gated; spending money
  (high/critical) escalates via the pending-approval flow. This design adds zero new
  autonomy mechanics.

---

## 9. Configuration

`config/default.yaml`:

```yaml
tasks:
  heartbeatIntervalMinutes: 60      # hourly tick
  heartbeatMaxWakesPerTick: 5       # global cap; per-agent cap is always 1
  idleThresholdHours: 4             # active idle (open/in_progress, curia-owned)
  staleWaitThresholdHours: 48       # orphaned waits (waiting/blocked, no wake set)
```

Priority bands, default `owner='curia'`, and other nuance are handled by LLM judgment, not
config — the LLM handles nuance, config handles mechanics.

---

## 10. Deferred (post-v1)

Captured so future readers do not relitigate the scope decisions: a `goals` table and
weighted progress rollup (tags carry us until a durable cluster appears); autonomous task
generation from inferred needs; a first-class `commitments` entity (modeled today as a task
with `owner='external'` + `waiting_on_contact_id`); DAG dependencies beyond a single
`blocked_by_task_id`; an LLM groomer that dedupes/re-prioritizes/promotes clusters; an
interactive digest surface; and a `last_advanced_at` column should `updated_at` prove a
noisy proxy for real progress.
