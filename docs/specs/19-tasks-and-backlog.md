# 19 — Tasks, Backlog & Resumable Projects

**Date:** 2026-06-04 (backlog); extended 2026-06-30 (resumable execution)
**Status:** Shipped (backlog v0.33; resumable execution Phases 0–3)
**Builds on:** [spec 07 — Scheduler](07-scheduler.md), [spec 14 — Autonomy Engine](14-autonomy-engine.md), [spec 01 — Memory System](01-memory-system.md)

## Overview

Curia is good at acting on a single request but historically lost fidelity across
sessions because there was no canonical place to track work — and it could not carry a
single job across more than one executor invocation. This spec covers the full task
system in two layers built on the same spine:

- **Tasks & backlog (§§1–8)** — a shared primitive for deferred, multi-step, and waiting
  work: a single `tasks` table, four `task-*` skills, a deterministic hourly heartbeat that
  keeps open work moving, and a CEO-visible backlog surfaced through the daily digest.
- **Resumable tasks & projects (§§9–16)** — the checkpoint/pause contract, the `plan`
  primitive, frontier advancement, throughput telemetry, adaptive re-planning, and
  principal-facing escalation that let a single goal run across many bursts without failing
  when it exceeds one budget.

The two shipped in sequence (the backlog layer in v0.33, resumable execution across Phases
0–3), but they are one system and are documented together here.

### The backlog layer addresses four recurring failure modes

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

### Resumable execution: work that exceeds a single invocation

The backlog layer (§§1–8) gave the platform a durable place to track work. It did not solve
**work that exceeds a single executor invocation**. A specialist sized as a lightweight
heartbeat (`max_turns: 25`) that is handed an unbounded job (audit ~1,300 follows, read 40
docs, dedupe 500 contacts) runs out of turns mid-work; the budget-hit was reported to the
coordinator as "didn't respond," which it confabulated into an external API timeout and
then blind-retried 51 times over 5 hours, leaving an orphaned subtask the heartbeat
re-poked indefinitely.

Sections 9–16 describe the resumable-task model that fixes that class of failure. The spine
is one idea: **a goal becomes a plan, progress is tracked as "X of Y done," and resumption
advances the frontier until done.** Both quantitative sweeps ("process 1,300 follows") and
qualitative goals ("design the kickoff with the 6 execs") are the same thing at the right
altitude — a planner breaking a goal into trackable units. The only thing that
distinguishes "kinds" of work is **materialization**: ~10 heterogeneous steps of a kickoff
become child task rows; a 1,300-item sweep stays a single leaf that loops over a cursor (no
row per item).

Two principles shaped the resumable model:

- **(A) No project foresight in agent authors.** You write a generic `social-media` agent;
  you never anticipate a follow-audit. The structure of a project is decided at runtime by
  the LLM through generic harness primitives, steered by platform guidance, and *guaranteed*
  by a deterministic safety-net — never by author-declared iteration.
- **(B) Materialization is the only reason to distinguish kinds of work.** A planned step
  becomes a real child row (dispatchable, blockable, schedulable). A high-count homogeneous
  step is one leaf with a cursor. One progress notion, one resume loop.

**Companion design docs** (the dated record of how this was designed and sequenced):
[2026-06-01-tasks-and-backlog-design.md](../wip/2026-06-01-tasks-and-backlog-design.md),
[2026-06-03-digest-backlog-sections-design.md](../wip/2026-06-03-digest-backlog-sections-design.md),
[2026-06-04-meeting-debrief-tasks-migration-design.md](../wip/2026-06-04-meeting-debrief-tasks-migration-design.md),
[2026-06-04-task-execution-heartbeat-design.md](../wip/2026-06-04-task-execution-heartbeat-design.md).

**Companion spec & ADR:** [spec 21 — Agent Document Workspace (OKF)](21-agent-document-workspace.md),
[ADR-024 — `plan` writes rows directly](../adr/024-plan-rows-direct.md). Resumable-execution
tracking epic: #1150.

---

## 1. Architecture Summary

- **One table.** The pre-existing `agent_tasks` table was renamed and promoted to
  `tasks` with CEO-visible columns. There is no parallel table; existing scheduler and
  persistent-task callers continued to work after a mechanical rename plus one column
  migration (§2).
- **Four skills.** `task-create`, `task-list`, `task-update`, `task-complete` — granular
  domain skills matching the existing `calendar-*` / `ceo-inbox-*` pattern.
- **No new specialist agent.** Task management is a platform-level capability available
  to any agent (like memory), gated by pinning the `tasks` skill (§4).
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
| `tags` | `TEXT[] NOT NULL DEFAULT '{}'` | Lightweight clustering (`'debrief-pending'`, `'inbox-drain'`) without a goals entity. |
| `originator` | `JSONB` | **Lineage** (migration 065, #1125): the chain's `TaskOriginator`, copied from the creating event's originator at creation; child tasks copy the parent's lineage, never above it. Immutable; pure audit + the *ceiling* an effective-standing computation may inherit. NULL on pre-065 / unstamped rows → treated as agent / no-bypass. |

Preserved verbatim from `agent_tasks`: `intent_anchor` (durable goal statement),
`progress` JSONB (multi-burst execution state), `error_budget`, `conversation_id`,
`agent_id`, timestamps.

`progress` keys used by the platform (all optional; absent when unused):

| Key | Purpose |
|-----|---------|
| `notes` | Human-readable progress notes (`task-update`) |
| `resumable` | Checkpoint cursor / accumulator (§10) |
| `plan` | Planned child-step descriptors (§13) |
| `activeSkills` | Tier-1 skill activations for this task — MRU list of `{ name, activatedAt }`, capped; re-loaded on wake with relevance re-check (spec 03 / #1495) |

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
participating agents via the `tasks` skill bundle (§4); document workspace is a separate
`documents` skill.

---

## 4. The `tasks` and `documents` Skills

The executor discipline (§6) is behavioral; hand-injecting it into each agent prompt
would drift the moment someone hand-builds a custom agent. Instead agents pin skill
bundles:

```yaml
# agents/<name>.yaml
pinned_skills:
  - tasks       # heartbeat + task-* tools + Task Management instructions
  - documents   # doc-* tools + Document Workspace instructions
```

These replace the former `enable_task_management` flag (two capabilities welded together).

**`tasks`** (`skills/tasks/SKILL.md`):

1. **Expands** to `task-create`, `task-list`, `task-update`, `task-complete`.
2. **Injects** the Task Management guidance block from the SKILL.md body.
3. **Marks the agent heartbeat-eligible** — only agents that pin a skill with
   `heartbeat: true` appear in the heartbeat's `source_agent_id` allow-list (§5).

**`documents`** (`skills/documents/SKILL.md`):

1. **Expands** to `doc-read`, `doc-list`, `doc-write`, `doc-search`.
2. **Injects** the Document Workspace guidance block.
3. **Enables** the document-workspace runtime surface (`documentWorkspaceEnabled`).

`taskRepo` is wired whenever **either** skill is pinned (task-wake scheduler refresh and
document project-root resolution both need it). `workingDocsRepo` stays documents-only.

Shipped on **`coordinator`**, **`ceo-inbox`**, and **`contacts`** (both pins). An agent
may still list individual `task-*` tool names in `pinned_skills` *without* the bundle for
a bespoke need (e.g. read-only `task-list`) — that agent is not heartbeat-eligible and
gets no injected block. If a task's `source_agent_id` points at a non-eligible or null
agent, the heartbeat routes the wake to the coordinator.

Instruction prose lives only in the SKILL.md files — there is no parallel TypeScript
constant.

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

### 5.3 Lineage on the wake (#1125)

The candidate query returns each task's `originator` (lineage) plus a `derived` flag
(`source = 'agent' OR parent_task_id IS NOT NULL`). `enqueueTaskWake` persists the originator
onto the wake `scheduled_jobs` row and carries `derived` in its `task_payload.standing`; when
the scheduler fires the wake it stamps a `wakeContext` onto the `agent.task` metadata. The
execution layer reads that marker and applies the autonomy **bypass ladder** — the woken task's
effective standing is the lineage downgraded by the live score, never raised. See
[14-autonomy-engine.md](14-autonomy-engine.md#effective-standing--the-bypass-ladder-wokenderived-tasks).
A specific `wake_at` job and a `scheduler-create` job are *not* heartbeat wakes: they carry no
`wakeContext` and keep their originator at fire time.

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
parent-rollup machinery in v1. Complex goals graduate to the `plan` primitive (§13), which
materializes and advances that decomposition automatically.

---

## 7. CEO Visibility: Digest Sections

`pending-actions-digest` (daily) gained three backlog sections after the existing
approvals block, each rendered only when non-empty and capped at 5 with a `+N more` footer:

- **For you to do** — `owner='ceo'`, status `open`/`in_progress`, top 5 by priority.
- **Waiting on others** — `owner='external'`, `status='waiting'`; resolves
  `waiting_on_contact_id` to a display name, falling back to `waiting_on_text`.
- **What I'm working on** — `owner='curia'`, status `open`/`in_progress`, top 5 by priority.

Email-observation learning (ADR-029) adds two further sections, also rendered only when
items exist:

- **Proposed voice diffs** — `WritingVoice` changes that need one-tap approve/dismiss
  ([spec 13](13-office-identity.md)).
- **Task-completion candidates / undo notes** — sent-mail matches awaiting confirm, plus
  reversible notes for auto-completes (see §8 below).

This reuses the existing digest the CEO already reads; no parallel digest or new channel
was introduced. Interactive controls (snooze / done / reassign) beyond approve/dismiss/undo
for these learning surfaces are explicitly deferred.

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
- **`ceo-inbox`** joins the system (`pinned_skills` includes `tasks` + `documents`): reification in the
  NEEDS DRAFT path prevents bare forward commitments; resume mode drafts the complete reply
  when a deferred follow-up task wakes. Large unread bursts are handled by **batch draining**
  rather than load-shedding: each run fully triages one fixed-size batch and, if more unread
  remain, self-wakes via a single `tag='inbox-drain'` continuation task (`owner='curia'`,
  near-term `wake_at`) until the inbox is empty. There is no watermark — read/archive status
  is the "already-triaged" marker — and no per-message overflow to-do tasks.
- **Sent-mail task-completion (ADR-029).** The daily `ceo-inbox-sent-observe` job
  ([spec 04](04-channels.md)) correlates new Sent messages to open `owner='ceo'` tasks by
  recipient + subject + semantic similarity of body to title/description. Action is
  **hybrid by match confidence and task risk** (risk inferred from the task — has a
  `plan`/subtasks, high `priority`, or sensitive tags such as `board`/`legal` = high-risk;
  no new risk column):

  | | Low-risk task | High-risk task |
  |---|---|---|
  | High-confidence match | Auto-`task-complete` with reversible digest undo note | Confirm in digest |
  | Low-confidence match | Confirm in digest | Confirm in digest |

  High-risk tasks (e.g. "Plan AGM") never auto-complete. Fuzzy candidates are recorded in the
  `sent_observe.asked_task_ids` guard set (config-store, `ceo_inbox`) so they are not
  re-surfaced every run. Auto-completes remain reversible via reopen from the digest undo note.
- **Autonomy** ([spec 14](14-autonomy-engine.md)). The "execute the safe stuff, escalate
  the rest" behavior is the existing autonomy engine — `action_risk` per skill against the
  live score. Drafting (low) just happens; outbound (medium) is gated; spending money
  (high/critical) escalates via the pending-approval flow. Task-completion and voice
  write-back reuse existing floors (`task-complete` = `low`/60, profile update = `medium`/70);
  this design adds zero new autonomy mechanics for those loops. Shadow-draft competence
  feeds Phase 3 only (ADR-029).

---

## 9. The resumable-execution contract

An executor invocation returns one of three outcomes (`src/agents/resumable-task.ts`):

| Outcome | Meaning | Effect |
|---|---|---|
| `done` | Work complete | Task → `done`; carries the final summary/deliverable |
| `paused` | Real progress made, more remains | Task stays `in_progress`; checkpoint persisted; continuation scheduled. **Success at the delegation layer, not a timeout.** |
| `failed` | Genuine error | Carries a structured `reason` (the executor-contract `ExecutorFailureReason`: `budget_max_turns`, `tool_error`, `api_error`, `blocked`) and `retryable: bool`, propagated honestly upward |

`paused` **reuses the existing `in_progress` status** — no new task status, no schema churn.
It is signalled through the `EXECUTION_PAUSED_PROTOCOL` marker on the `agent.response`
(`buildExecutionPausedResponse` / `parseExecutionPausedPayload`). The delegate layer treats
`paused` as success (no re-delegation); `failed{retryable:false}` escalates without blind
retry; `failed{retryable:true}` gets a bounded retry then escalates (`DelegationGuard`,
`src/agents/delegation-guard.ts`). This ends the confabulation: the coordinator now receives
a real failure `reason` (e.g. `maxTurns` for turn-budget exhaustion) and reports the truth.

> **Two `reason` vocabularies — mind which surface you're reading.** The `failed`
> reason is spelled differently on the two surfaces it crosses, and the coordinator
> sees the second one:
>
> - **Executor contract** — `ExecutorFailureReason` = `budget_max_turns | tool_error | api_error | blocked` (`src/agents/resumable-task.ts`). The outcome-contract token on `ExecutorOutcome.failed`.
> - **Coordinator-facing** — `AgentResponseFailureReason` = `maxTurns | maxConsecutiveErrors | tool_error | api_error | blocked` (`src/bus/events.ts`). What actually rides the `agent.response` event to the coordinator / delegate skill; the runtime derives it from the classified `AgentError` (`mapAgentErrorToResponseFields`, #1170).
>
> Mapping between them: the executor's `budget_max_turns` corresponds to the
> coordinator-facing `maxTurns` (turn-budget exhaustion); `tool_error`, `api_error`,
> and `blocked` are shared verbatim. `maxConsecutiveErrors` is an *additional*
> coordinator-facing reason (the consecutive-error ceiling was hit) with no distinct
> executor-contract token.

## 10. Resumable state — the `progress.resumable` block

Resumable state lives in the existing `tasks.progress` JSONB under a `resumable` block (no
migration), defined and bounded in `src/db/resumable-progress.ts`:

- `cursor` (opaque, LLM-authored), `done` / `total`, `lastSliceUnits`, a one-line `next`,
  `checkpointedAt`, and an `accumulator`.
- The accumulator is **bounded**: an inline cap (4 KB) and an overall block cap (8 KB). On
  overflow it spills to the document workspace (`working_documents`, [spec 21](21-agent-document-workspace.md))
  and the block stores a `{ kind: 'document', path, section? }` pointer instead.

`TaskRepo.getResumableBlock` / `setResumableBlock` are the only read/write path; writes
publish `task.updated` for audit. A task is "resumable" when `error_budget.resumable=true`,
a `resumable` tag is present, or a checkpoint already exists (`isResumableTask`).

## 11. Checkpointing — a harness guarantee, not an author convention

- **Cooperative.** The platform injects a fixed-slot resumable-task guidance block
  (`buildResumableTaskGuidanceBlock`, `src/agents/runtime.ts`) — *not* author-editable — plus
  a generic `checkpoint(progress)` skill (`skills/checkpoint/`, `action_risk: low`) dynamically
  pinned per-turn for resumable tasks. When remaining budget drops below ~15%, a one-time
  "checkpoint and pause now" nudge is appended to the **message tail** (never the cached
  tools/system prefix, so prefix caching survives across providers).
- **Safety-net (the real guarantee).** If the runtime hits the hard budget wall anyway,
  `handleBudgetExceeded()` converts the budget-hit into `paused` from the last persisted
  checkpoint instead of emitting `BUDGET_EXCEEDED`. With no checkpoint, it is an honest
  `failed`. Correctness rests on the safety-net; the nudge is a latency optimization.
- **Throughput-informed (#1264/#1265).** Each pause computes rolling throughput
  (`computeResumableThroughput`, `src/agents/resumable-throughput.ts`) — units/slice,
  cost/unit, and an ETA — and emits a `task.resumable_throughput` audit event
  (`src/bus/events.ts`). The resume-guidance block and the budget nudge carry those
  figures plus an **advisory** suggested slice size derived from the measured units/slice
  (`suggestedSliceSize`; cold start falls back to the fixed turn fraction), so the next
  continuation is sized from evidence rather than a guess.

## 12. The resume loop & circuit-breaker

A `paused` task schedules its **own near-term continuation** wake (`scheduled_jobs`,
default `tasks.resumableContinuationSeconds: 30`) routed to its `source_agent_id`
(`src/agents/resumable-continuation.ts` + `resumable-continuation-subscriber.ts`), rather
than waiting for the hourly `BacklogHeartbeat`, which remains the backstop. A partial unique
index (migration 067) enforces at most one active wake per task.

The circuit-breaker keys on **progress, not error count** (`src/agents/resumable-circuit-breaker.ts`,
state in `progress.resumableCircuit`). A continuation that makes no forward progress (cursor
unchanged and done-count flat) increments a stall counter; after K stalls, or on breach of a
hard per-task ceiling, the task is failed and escalated via the existing `needs-attention`
backlog path. The escalation carries a structured, principal-facing payload
(`src/agents/task-escalation.ts`, #1267) — one of four real failure modes (**stalled** /
**hit-a-limit** / **blocked-on-a-person** / **agent-couldn't-finish**), progress, throughput +
ETA (resumable leaves) or X-of-Y (planned parents), and suggested next actions — stored at
`progress.escalation` and rendered into the CEO row's `last_progress_note` so the daily digest
surfaces real detail, not a bare row. Defaults (`tasks.resumableCeilings`): `maxStalls: 3`, `maxIterations: 100`,
`maxWallclockHours: 24`, `maxCostUsd: 10`; each is overridable per task through the
`error_budget` keys validated in `src/tasks/task-error-budget.ts` (per #883: per-task keys
only — per-invocation `max_turns`/`max_errors` belong to agent config and are rejected on
task rows).

## 13. The `plan` primitive

For goals too complex for a single leaf, the runtime LLM calls `plan(goal)` (`skills/plan/`,
`action_risk: low`), symmetric with `checkpoint` and dynamically pinned for complex/planned
tasks (`shouldOfferPlanSkill` / `applyPlanHarness`, `src/agents/planned-task.ts`).

- **Rows-direct** ([ADR-024](../adr/024-plan-rows-direct.md)): `plan` writes child task rows
  itself via `TaskRepo` (reusing `task-create` internals), rather than proposing a tree the
  coordinator commits — keeping the decomposition loop out of the prompt layer that
  confabulated. Children carry `parent_task_id`, `blocked_by_task_id`, and
  `waiting_on_contact_id` (human-input steps the heartbeat already treats specially).
- **Progressive & lazy** — a step decomposes further only when picked up (`materialize:false`
  leaves it unmaterialized in the plan block until then).
- **Adaptive** — re-running `plan` on a planned parent reconciles steps against existing
  children by step id (reuse, cancel drift, cancel removed) without duplicating.
- **Materialization altitude** — a high-count homogeneous step is created as a single
  iterate leaf (`resumable=true`), not one row per item.

Planned-step state lives in `tasks.progress.plan` (`src/db/plan-progress.ts`,
`PlanProgressBlock`): the ordered step descriptors (each pointing at its child row id),
`deliverableStepId`, and an "X of Y" rollup (`computePlanRollup`, resolved = `done`/`cancelled`).
A task is a planned step iff this block is present (`isPlannedStep`) — no new column/status.
The block is bounded; wide plans store references, never per-item data.

## 14. Frontier advancement, reconciliation, and the deliverable

- **Frontier advancement** (`PlanFrontierSubscriber`, `src/agents/plan-frontier-subscriber.ts`; the
  advance logic is `advancePlanFrontier` in `src/agents/plan-frontier.ts`). When a
  child resolves, the subscriber wakes its planned parent (reusing the continuation wake +
  dedup) routed to the parent's `source_agent_id`. On the wake, `advancePlanFrontier`
  recomputes the rollup, dispatches newly-unblocked children, and re-evaluates the plan. The
  heartbeat is the backstop.
- **Completion reconciliation.** When a parent reaches a **terminal** state — `done`,
  `cancelled` (`updateTask`/`completeTask`) **or `failed`** (`failResumableTask`, the
  circuit-breaker path) — its open descendant children are recursively cancelled with a
  reason and their pending wakes cancelled, in one transaction (`reconcileChildren` /
  `runReconcileChildrenQuery`). This is the direct fix for the orphaned-subtask futility loop:
  no terminal parent leaves children for the heartbeat to re-poke.
- **Auto-complete + deliverable.** When the subtree is resolved and the deliverable step is
  done, the parent auto-completes (`isPlanReadyForAutoComplete`). The parent's result is the
  `deliverableStepId` step's output, or a rollup of child summaries in plan order when no
  deliverable is marked (`resolvePlanCompletionNote`, `src/agents/plan-execution.ts`).
  Synthesis is not special machinery — it is just the last planned step, surfaced through the
  existing completion path.
- **Adaptive re-planning (#1266).** On each frontier wake, `detectPlanDivergence`
  (`src/agents/plan-adaptive-replan.ts`) raises advisory divergence signals — a `child_failed`
  or `child_cancelled` child, `throughput_below_estimate` (measured pace under
  `throughputDivergenceRatio` of the implied pace), or a `step_over_blocked` child past
  `blockedStepHours`. `buildPlanDivergenceGuidanceBlock` injects them into the planned-parent
  harness (`src/agents/planned-task.ts`) as a **non-authoritative** hint for the LLM's next
  `plan` call — the runtime never rewrites the plan itself. Re-planning is bounded:
  `detectPlanAdaptiveBreach` / `escalatePlanAdaptiveBreach` escalate when a subtree exceeds
  `maxPlanDepth` or `maxReplansPerSubtree`, so a diverging plan escalates instead of thrashing.

## 15. Promoting the deliverable to the knowledge graph

On a planned parent's completion, `DeliverableKgPromotionSubscriber`
(`src/agents/deliverable-kg-promotion.ts`) distils the **curated deliverable** (never the
per-item worklog) into the KG through the existing `extract-facts` / `extract-relationships`
gates — typed, source-attributed, and **capped per project** (`documentWorkspace.kgPromotion`:
`maxFacts: 50`, `maxRelationships: 50`). Promotion is **best-effort and non-fatal**
(fire-and-forget with a catch; it can never fail the parent's completion), is disableable
globally (`documentWorkspace.kgPromotion.enabled: false`), disableable per task
(`error_budget.kg_promotion: false`), and archives the project's
workspace docs (`archived_at`) afterward.

## 16. Task-wake clarifications

A woken task that needs input it cannot supply itself asks the principal a question and suspends
until the answer returns — the clarification counterpart of the resume loop in §12.

The question is sent from the task's scheduler conversation, but the principal answers on their own
channel (Signal, email), so the reply cannot be matched back to the task structurally. Instead, the
outbound question registers a **durable reply binding** on the originating task: an outbound-context
entry recording the task id and a short preview of the question, held for 7 days (long enough that a
principal may take days to answer). When an inbound reply arrives, the coordinator decides whether it
answers an outstanding question and, if so, writes the answer back to the bound task through
`context-bridge-release`; binding is a judged relevance decision, not an automatic structural match.
With several questions outstanding at once, the coordinator matches the reply to the right task by
content, using the stored preview. A binding whose task no longer exists is released rather than
retried.

A milestone subtask whose due date has already passed at creation wakes immediately to be worked,
rather than being treated as already complete.

---

## 17. Configuration

`config/default.yaml`:

```yaml
tasks:
  # Backlog heartbeat (§5)
  heartbeatIntervalMinutes: 60      # hourly tick
  heartbeatMaxWakesPerTick: 5       # global cap; per-agent cap is always 1
  idleThresholdHours: 4             # active idle (open/in_progress, curia-owned)
  staleWaitThresholdHours: 48       # orphaned waits (waiting/blocked, no wake set)
  # Resumable execution (§§9–16)
  resumableContinuationSeconds: 30  # near-term continuation cadence (vs. hourly heartbeat)
  resumableCeilings:
    maxStalls: 3                    # K consecutive no-progress continuations → escalate
    maxIterations: 100              # hard cap on continuation slices
    maxWallclockHours: 24           # elapsed cap from first pause
    maxCostUsd: 10.00               # aggregate LLM cost cap across slices
    maxPlanDepth: 3                 # max plan-decomposition depth per subtree (#1266)
    maxReplansPerSubtree: 5         # max adaptive re-plans per planned subtree (#1266)
    blockedStepHours: 48            # blocked-child hours before a divergence signal (#1266)
    throughputDivergenceRatio: 0.5  # measured/implied pace floor before flagging (#1266)

documentWorkspace:
  kgPromotion:
    enabled: true
    maxFacts: 50
    maxRelationships: 50
```

Priority bands, default `owner='curia'`, and other nuance are handled by LLM judgment, not
config — the LLM handles nuance, config handles mechanics. Per-task overrides live in
`tasks.error_budget` (`resumable`, `kg_promotion`, `max_stalls`, `max_iterations`,
`max_wallclock_hours`, `max_cost_usd`, `max_plan_depth`, `max_replans_per_subtree`,
`blocked_step_hours`, `throughput_divergence_ratio`) — the keys validated in
`src/tasks/task-error-budget.ts`.

---

## 18. Deferred (post-v1)

The resumable-execution model (§§9–16) covers what an earlier draft of this spec deferred:
durable multi-step projects with a weighted progress rollup (the `progress.plan` "X of Y")
and decomposition with dependencies. It reuses the `tasks` + `scheduled_jobs` + heartbeat
spine above — no parallel "project runner" subsystem was introduced (explicitly rejected in
the design memo).

What genuinely remains deferred, captured so future readers do not relitigate the scope
decisions:

- a first-class `goals` table with a weighted progress rollup (tags carry us until a durable
  cluster appears);
- a first-class `commitments` entity (modeled today as a task with `owner='external'` +
  `waiting_on_contact_id`);
- DAG dependencies beyond a single `blocked_by_task_id`;
- autonomous task generation from inferred needs;
- an LLM groomer that dedupes / re-prioritizes / promotes clusters;
- an interactive digest surface (snooze / done / reassign beyond approve/dismiss/undo);
- a `last_advanced_at` column, should `updated_at` prove a noisy proxy for real progress.
