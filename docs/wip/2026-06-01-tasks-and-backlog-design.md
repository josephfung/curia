# Design: Unified Tasks & Backlog (v1)

**Status:** Design, pre-implementation
**Date:** 2026-06-01
**Companion docs:** [07-scheduler.md](../specs/07-scheduler.md), [17-meeting-debrief.md](../specs/17-meeting-debrief.md), [03-skills-and-execution.md](../specs/03-skills-and-execution.md)

---

## Context

Curia today is good at acting on a single request, but loses fidelity across sessions because there is no canonical place to track work. Four concrete failure modes recur in operation:

1. **No ownership distinction.** Curia cannot tell "I should do this" from "the CEO should do this" from "we're waiting on someone else." Every loose end is rendered the same way.
2. **No persistence for larger projects.** Multi-step work either crams into one burst or falls on the floor between bursts.
3. **Specialist agents are bursty.** When `meeting-debrief` or `ceo-inbox` uncovers seven follow-ups, the only options are "do all of them now" or "drop them." This produces unpredictable explosions of action — or nothing at all.
4. **Everything is treated as urgent.** No priority signal means every newly-discovered item competes for the same immediate attention.

The smoking gun is `meeting-debrief`'s `pendingDebriefs` and `judgedEvents` maps in `agent_tasks.progress` ([spec 17 §3](../specs/17-meeting-debrief.md#3-state-management)). That feature reinvented an ad-hoc per-agent task tracker because no platform-level one existed. The same need will recur for `ceo-inbox`, the eventual research-analyst long-running queries, and every future specialist. The platform should provide the shared primitive.

This design adds a unified Tasks system that lets agents defer work, the CEO see what's open, and Curia smooth its own execution across the day. Goals are deliberately deferred to a later phase — they only earn their keep once a real backlog of tasks exists to organize. v1 ships the backlog; Goals can be a thin parent table later if usage justifies it.

The design leans heavily on infrastructure that already exists:

- `scheduled_jobs` + `agent_tasks` ([spec 07](../specs/07-scheduler.md)) — Postgres-backed scheduler with cron, one-shot, and persistent multi-burst task state.
- The existing `pending-actions-digest` (daily) — the CEO's existing read surface.
- Memory engine + audit trail — provenance and history for every task event already supported by existing infrastructure.

---

## Goals & Non-Goals

### Goals (v1)

- Specialist agents can defer non-urgent work into a queryable backlog rather than executing everything in-burst.
- The CEO can ask "what's open?" / "what's waiting on me?" / "what are you working on?" in any channel and get a real answer.
- Curia advances the backlog autonomously between events (backlog sweep), not only when prompted.
- Three-way ownership (`curia` / `ceo` / `external`) is first-class.
- `meeting-debrief`'s bespoke state migrates to the new model, proving the abstraction holds.

### Non-goals (v1 — see §11)

- A `goals` table or weighted progress rollup.
- Autonomous task generation from inferred needs ("you haven't talked to a recruiter in 21 days").
- First-class commitments as a separate entity.
- DAG dependencies beyond a single `blocked_by_task_id`.
- A dedicated UI surface or new channel.

---

## 1. Architecture Summary

- **One table:** the existing `agent_tasks` is renamed to `tasks` and gains CEO-visible columns. There is no parallel table. Existing scheduler and persistent-task callers continue to work after a mechanical rename + one column migration (see §4).
- **Four new skills:** `task-create`, `task-list`, `task-update`, `task-complete`. Pattern matches existing granular skill domains (`calendar-*`, `ceo-inbox-*`).
- **No new specialist agent.** Task management is a platform-level capability available to every agent, the same way memory is. The coordinator gains a backlog-sweep declarative job and prompt awareness, but does not become a "task manager."
- **Two execution paths drain the backlog:**
  1. **Per-task wake-up.** When an agent wants a task to wake later, it creates a one-shot `scheduled_jobs` row carrying `task_id`. The scheduler (unchanged) fires it; the dispatcher sees `task_id` on the row, loads the task, and routes the fire to `source_agent_id` (or coordinator if null). The scheduler reads only `scheduled_jobs`, never the `tasks` table.
  2. **Backlog sweep.** A new declarative job on the coordinator runs 3×/day (default 7am / 1pm / 7pm local), pulls top-N unblocked open tasks, advances 1–3 of them.

### 1.1 Scheduler ↔ Tasks relationship

This split is the single most important architectural decision in this design — getting it wrong would produce a system where two tables race to be the source of truth for "when should this happen." Making the split explicit:

- **`scheduled_jobs` owns "when."** Cron and one-shot triggers. Polled every 30s. No new polling logic introduced.
- **`tasks` owns "what."** Units of CEO-visible work. The tasks table is *unaware of scheduling* — no `next_attempt_at`, no `scheduled_job_id`.
- **The bridge is a one-way FK from `scheduled_jobs` → `tasks`:**

  ```sql
  ALTER TABLE scheduled_jobs
    ADD COLUMN task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;
  CREATE INDEX scheduled_jobs_task_idx ON scheduled_jobs (task_id)
    WHERE task_id IS NOT NULL;
  ```

  Most `scheduled_jobs` rows have `task_id = NULL` (digests, sweeps, cron-driven agents). A task-bound row exists only when an agent specifically asked to wake a task at a particular time.
- **Cancellation is clean.** When a task is completed or cancelled, the task layer cancels `scheduled_jobs WHERE task_id = ? AND status = 'pending'`. No JSONB payload spelunking.
- **`due_at` on `tasks` is a CEO-facing deliverable date** ("this matters by Friday"), not a wake-up trigger. If a wake-up at `due_at` is desired, the task-creation skill emits a `scheduled_jobs` row for it. The two concepts are distinct and not double-stored.

The pre-existing `agent_tasks.scheduled_job_id` field (a back-FK created in [spec 07](../specs/07-scheduler.md)) is dropped in the migration. The new one-way `scheduled_jobs.task_id` replaces it. The previous direction supported one use case (find the schedule for a task); the new direction supports the same use case and additionally supports the more frequent question (find the task for a firing job), without requiring a second query path.

### 1.2 Key conceptual split: owner vs source_agent_id

The original v2 doc proposed `owner_type = user | coordinator | agent`. That conflates two distinct concepts:

- **Who is accountable for the outcome.** A person or organization.
- **Who or what can advance the work.** An internal routing detail.

This design separates them:

- `owner` — `'curia' | 'ceo' | 'external'`. CEO-visible. Drives the digest's three-way grouping and the "what should I do vs what is Curia doing vs what are we waiting on" distinction the CEO needs.
- `source_agent_id` — internal. Identifies the specialist agent that originally created the task and is best positioned to resume it (`'meeting-debrief'`, `'ceo-inbox'`, `'research-analyst'`, etc.). May be null for CEO-created tasks.

When a wake-up fires for a task, the dispatcher routes to `source_agent_id`. When the CEO asks "what's waiting on me?", the digest queries by `owner='ceo'`. The two questions never need to consult the same field.

---

## 2. Data Model

### 2.1 Migration

Promote `agent_tasks` → `tasks`, add CEO-visible columns, drop the back-FK, add the forward `task_id` on `scheduled_jobs`.

```sql
-- Promote & rename
ALTER TABLE agent_tasks RENAME TO tasks;

-- Drop the old back-FK; the new direction is scheduled_jobs.task_id (below)
ALTER TABLE tasks DROP COLUMN scheduled_job_id;

ALTER TABLE tasks
  ADD COLUMN title TEXT NOT NULL,
  ADD COLUMN description TEXT,
  ADD COLUMN owner TEXT NOT NULL DEFAULT 'curia'
    CHECK (owner IN ('curia', 'ceo', 'external')),
  ADD COLUMN waiting_on_contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN waiting_on_text TEXT,
  ADD COLUMN parent_task_id UUID REFERENCES tasks(id),
  ADD COLUMN blocked_by_task_id UUID REFERENCES tasks(id),
  ADD COLUMN priority INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN due_at TIMESTAMPTZ,                       -- CEO-facing deliverable date, not a wake-up
  ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'
    CHECK (source IN ('ceo', 'agent', 'scheduler', 'coordinator')),
  ADD COLUMN source_agent_id TEXT,                     -- which agent can resume this task
  ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';

-- Status lifecycle: 'open' | 'in_progress' | 'blocked' | 'waiting' | 'done' | 'cancelled'
-- The existing status CHECK constraint (from agent_tasks) expands to this set.

-- Forward FK: scheduled_jobs → tasks. Nullable; only set when a fire is
-- meant to wake a specific task.
ALTER TABLE scheduled_jobs
  ADD COLUMN task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX tasks_open_priority_idx ON tasks (priority DESC, due_at NULLS LAST)
  WHERE status IN ('open', 'in_progress');
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id);
CREATE INDEX scheduled_jobs_task_idx ON scheduled_jobs (task_id)
  WHERE task_id IS NOT NULL;
```

### 2.2 Notable design choices

- **No `next_attempt_at` on tasks.** Wake-up timing lives in `scheduled_jobs`. A task that wants to wake at time T is a `tasks` row plus a one-shot `scheduled_jobs` row pointing at it. This is what avoids the dual-source-of-truth trap.
- **No `scheduled_job_id` on tasks.** The relationship is one-way (forward FK from `scheduled_jobs`). Cancellation queries the schedule table, not the task.
- **`due_at` is the CEO-visible deliverable timestamp.** Surfaced in the digest. Not a scheduling primitive.
- **`waiting_on_text` exists for unknown counterparties.** Most "waiting on someone" tasks reference a `contacts` row via `waiting_on_contact_id`, but the CEO can say "waiting on the lawyer's response" before that contact exists. The text field is a soft alternative; the contact reference is preferred.
- **`tags` provide lightweight clustering** (`'board-prep'`, `'china-trip'`, `'debrief-pending'`) without a separate goals entity. When a meaningful cluster proves durable, it can graduate to a real `goals` row in a later spec.
- **Status `'waiting'` vs `'blocked'`.** Waiting = something outside Curia must happen (an external person, a future date, a third-party system). Blocked = another known task must complete first. Both are paused but the distinction is useful in the digest.

### 2.3 Preserved fields

Existing fields from `agent_tasks` are preserved verbatim and continue to mean what they meant in spec 07:

- `intent_anchor` — the durable goal statement an agent reasons from across bursts.
- `progress` (JSONB) — multi-burst execution state, including any per-agent context (e.g., what `meeting-debrief` previously held in `pendingDebriefs`).
- `error_budget` — failure-rate accounting.
- `conversation_id`, `agent_id`, timestamps.

The only call-site change is that everywhere reading `agent_tasks.scheduled_job_id` must migrate to querying `scheduled_jobs WHERE task_id = ?`. See §9 (Issue 1).

---

## 3. Skills

Four new skills under `skills/`. Manifests follow the existing `skill.json` convention with explicit `action_risk` (per [CLAUDE.md](../../CLAUDE.md)).

| Skill | Args | `action_risk` | Notes |
|---|---|---|---|
| `task-create` | `title*`, `description?`, `owner?`, `parent_task_id?`, `blocked_by_task_id?`, `priority?`, `due_at?`, `wake_at?`, `tags?`, `waiting_on_contact_id?`, `waiting_on_text?`, `intent_anchor?` | `low` | Auto-fills `source` and `source_agent_id` from the caller context. `wake_at` is a *convenience argument* — when set, the skill creates the task and a one-shot `scheduled_jobs` row (with `task_id` set) in one transaction. The wake time is stored on the schedule row, not the task. |
| `task-list` | `status?`, `owner?`, `tag?`, `parent_task_id?`, `due_before?`, `limit?` (default 25) | `none` | Default sort: `priority DESC, due_at ASC NULLS LAST`. Returns title, status, owner, due_at, age, last progress note, and (joined) the next pending wake-up if any. Timestamps formatted via `toLocalIso()` per the CLAUDE.md skill convention. |
| `task-update` | `task_id*`, `status?`, `priority?`, `owner?`, `due_at?`, `wake_at?`, `tags?`, `progress_note?`, `blocked_by_task_id?` | `low` | Appends `progress_note` to `progress` JSONB. Setting `wake_at` cancels any existing pending wake-up for this task and creates a fresh one-shot. Status transitions validated (no `done → open`, etc.). Completing or cancelling a task auto-cancels its pending `scheduled_jobs` rows where `task_id = ?`. |
| `task-complete` | `task_id*`, `completion_note?` | `low` | Sets `status='done'`, captures note in audit + progress, auto-cancels pending wake-ups. Separate skill so the coordinator prompt can reason about completion cleanly and the audit log distinguishes completion from generic updates. |

**Deliberately not included in v1:**

- `task-delete` — cancellation uses `status='cancelled'` to preserve audit trail.
- `task-get` — `task-list` with a filter handles single-row reads at v1 volume.
- `task-add-subtask` / `task-block-on` — `task-create` with `parent_task_id` and `task-update` with `blocked_by_task_id` already handle these.

All four skills must be pinned to the coordinator and to any specialist agent that creates tasks (see §4). Per CLAUDE.md: a skill not pinned to an agent is effectively invisible to it.

---

## 4. Coordinator Changes

`agents/coordinator.yaml`:

### 4.1 Pin the new skills

Add `task-create`, `task-list`, `task-update`, `task-complete` to the coordinator's `pinned_skills`.

### 4.2 New declarative scheduled job: `backlog-sweep`

```yaml
schedule:
  - cron: "0 7,13,19 * * *"
    task: "Review open tasks and advance the top of the queue"
    expectedDurationSeconds: 180
```

Per-run behavior (driven by the system prompt, not custom handler code, consistent with the `ceo-inbox` pattern):

1. Call `task-list status=open,in_progress limit=10`.
2. Pick 1–3 tasks that can meaningfully be advanced right now.
3. For each chosen task, decide:
   - **Do now** — delegate to the appropriate specialist via the existing `delegate` skill, then `task-update status='in_progress'` with a progress note.
   - **Ask the CEO** — surface via the existing outbound flow (Bullpen-through-coordinator pattern from [spec 17 §4](../specs/17-meeting-debrief.md#4-reply-routing-via-context-bridging-v2)) and `task-update status='waiting'` with a note explaining what's needed.
   - **Defer further** — `task-update wake_at=…` with a brief reason.
4. Leave everything else untouched.

The 1–3 cap is intentional: the sweep should feel like a quiet steward, not a burst. If three sweeps a day each touches three tasks, that is nine deliberate advancements per day — enough to keep a real backlog moving without thrashing.

### 4.3 Prompt additions (small, targeted)

Three short additions to the coordinator's system prompt:

- **Backlog awareness.** "Before answering a CEO question about open work, what's waiting, or what you're working on, call `task-list`."
- **Defer-or-do rule.** "When you receive new work, decide: act now, queue for later (`task-create` with optional `wake_at`), or escalate to the CEO. If you queue something for later, briefly tell the CEO what you queued and why."
- **CEO natural-language entry.** "If the CEO says 'remind me to…', 'track…', 'queue up…', 'what's open?', 'mark X done', route through the `task-*` skills."

No explicit `ceo-add-task` skill in v1. The coordinator handles CEO-originated task creation via `task-create` with `source='ceo'` filled in from caller context.

---

## 5. Per-Task Wake-Up Routing

`src/scheduler/runner.ts` (or equivalent in `src/scheduler/`):

The scheduler loop is **unchanged**. It still polls only `scheduled_jobs` every 30s. The new behavior is in the *dispatch* step:

1. When firing a job, check `task_id` on the row.
2. If `task_id IS NULL` → existing behavior (route by `agent_id` and `task_payload`). No change.
3. If `task_id IS NOT NULL` → load the task, route the fire to `tasks.source_agent_id` (falling back to coordinator if null), pass the task as context (`task_id`, `intent_anchor`, `progress`, `title`).
4. The receiving agent advances the task — calls `task-update` (with a `progress_note`), optionally `task-complete`, optionally calls `task-update wake_at=…` to schedule another burst.

Only the routing branch is new; the polling loop, retry logic, error-budget accounting, and timezone handling from [spec 07](../specs/07-scheduler.md) are untouched.

---

## 6. CEO Visibility: Digest Extension

`src/digests/pending-actions-digest.ts` (or the equivalent module that owns the existing daily digest):

Add three sections after the existing approvals block. Each section renders only if non-empty:

- **For you to do** — `owner='ceo'`, status in `('open', 'in_progress')`, top 5 by `priority DESC, due_at ASC NULLS LAST`. Line format: `<title> · due <date|—> · age <duration>`.
- **Waiting on others** — `owner='external'`, `status='waiting'`. Resolve `waiting_on_contact_id` to a display name, falling back to `waiting_on_text`. Line format: `<title> · waiting on <name> · since <duration>`.
- **What I'm working on** — `owner='curia'`, status in `('open', 'in_progress')`, top 5 by priority.

Each section capped at 5 with a `+N more` footer when truncated. Use the existing digest formatting helpers; do not introduce a parallel digest or a new channel. The CEO already trusts and reads this digest — extending it is the lowest-friction read surface for v1.

A future iteration may add a more interactive surface (snooze / done / reassign controls) — explicitly out of scope here.

---

## 7. Migration Case Study: `meeting-debrief`

This migration is part of v1 because it is the proof case: if the abstraction cannot cleanly absorb the existing ad-hoc state, the abstraction is wrong and we revisit before shipping more on top of it.

[Spec 17 §3](../specs/17-meeting-debrief.md#3-state-management) describes the current state machine. Re-expressing it in the new model:

- `pendingDebriefs` → one task per pending debrief, with `tag='debrief-pending'`, `owner='ceo'` (the CEO owes Curia takeaways), and a `wake_at` set to the reminder time. The reminder is no longer custom code — it is just a scheduled wake-up like any other task. The current `pendingDebriefs[eventId]` JSON shape moves into the task's `progress` field, where it stays internal to `meeting-debrief`.
- `judgedEvents` → one task per judged event, `tag='debrief-judged'`, `owner='curia'`. Tasks with `judgment='no'` are completed immediately (`status='done'` with a `completion_note` capturing the reason); tasks with `judgment='defer'` get a `wake_at` for re-evaluation.
- Follow-up actions discovered during a debrief response → child tasks (`parent_task_id` pointing at the originating debrief task), `owner` chosen per action (`curia` for drafts and bookings Curia can do itself, `ceo` for calls only the CEO can make, `external` if the action is waiting on a third party).
- Cross-tick idempotency via `config-store` (the layer-2 guard described in [spec 17 §3.1](../specs/17-meeting-debrief.md#cross-tick-idempotency-via-config-store)) stays — it is independent of the state representation and still earns its keep.

Expected result: ~100 lines of bespoke state-tracking code deleted from `src/agents/meeting-debrief/`. The agent becomes a thin user of the platform task system. The CEO additionally gains: visibility into pending debriefs through the digest's "For you to do" section, and the ability to ask "what debriefs are outstanding?" via the coordinator without the dedicated `debrief-status` skill that earlier drafts of spec 17 considered (and which spec 17 itself later removed in favor of coordinator delegation).

---

## 8. Configuration

No new top-level config block is required for v1. Two values worth surfacing as configurable, with sensible defaults baked in:

- `tasks.backlogSweepCron` — default `"0 7,13,19 * * *"`. Lives on the coordinator's declarative schedule.
- `tasks.sweepBatchSize` — default `3` (the cap on how many tasks one sweep touches). Read from `config/default.yaml` if present; otherwise hard-coded default.

Everything else is implicit (priority bands, default `owner='curia'`, etc.). Following the §17 principle: the LLM judgment handles nuance; config handles mechanics.

---

## 9. Issue Breakdown (suggested PR sequence)

Each numbered item is one PR. Issue 0 (this design doc) is already produced and reviewed. Items 1–7 are sequenced so that each PR is independently reviewable and shippable. After items 1 and 2 land, items 3 and 4 can be parallelized; item 6 can begin once item 2 lands.

| # | Issue | Acceptance |
|---|---|---|
| 1 | **Migration + types: promote `agent_tasks` → `tasks`; add `scheduled_jobs.task_id`.** Rename, drop `agent_tasks.scheduled_job_id`, add new task columns, add forward FK, add indexes. Update every existing reader/writer that referenced `agent_tasks.scheduled_job_id` to use the new `scheduled_jobs.task_id` direction. Keep current persistent-task behavior intact. | Existing tests pass; typecheck clean; no user-facing behavior change observable in smoke tests. |
| 2 | **Task skills.** Implement `task-create`, `task-list`, `task-update`, `task-complete` with manifests (including `action_risk`), handlers, and unit tests. Includes the `wake_at` convenience that internally creates the linked `scheduled_jobs` row, and the auto-cancellation of pending wake-ups on `task-complete` or `status='cancelled'`. | Each skill is callable via the dev CLI; audit log records every operation; status-transition validation enforced (`done → open` rejected, etc.); wake-up rows are created and cancelled correctly; manifests pass startup validation. |
| 3 | **Coordinator integration.** Pin the four task skills to the coordinator. Add the `backlog-sweep` declarative scheduled job. Add the three prompt additions in §4.3. | Smoke tests for "what's open?", "remind me to call Steve Friday at 9am", "queue follow-up for the Acme deck", and "mark the Acme task done" all pass. The 7am sweep fires in a staging environment and produces sensible progress notes on at least one open task. |
| 4 | **Per-task wake-up routing in the scheduler dispatcher.** Only the dispatch branch changes; the polling loop is untouched. | Integration test creates a task with `wake_at = now + 10s`, asserts the source agent receives a fire with task context (`task_id`, `intent_anchor`, `progress`, `title`) and that the task's status reflects the work performed. |
| 5 | **Extend `pending-actions-digest` with backlog sections.** Three new sections per §6; cap at 5 with `+N more` truncation; existing approvals block unchanged. | Snapshot test renders all three sections correctly with realistic seeded tasks. CEO receives the next day's digest in staging with the new sections populated. |
| 6 | **Migrate `meeting-debrief` to tasks; delete `pendingDebriefs` / `judgedEvents` maps.** Per §7. | Existing debrief smoke tests pass; net negative LOC in `src/agents/meeting-debrief/`; no behavioral regression in the reminder flow; the digest "For you to do" section shows pending debriefs as tasks. |
| 7 | **(Stretch) `ceo-inbox` overflow → tasks.** When the inbox has more than N unread that warrant a reply, process the top priority and defer the long tail as tasks tagged `inbox-overflow` with `owner='ceo'`. Ship only if 1–6 land cleanly. | With 20+ unread, ceo-inbox processes the top-priority handful and defers the rest; the deferred items appear in the next digest under "For you to do". |

When opening these issues in GitHub, per [CLAUDE.md](../../CLAUDE.md) every issue needs: applicable pre-existing labels; one `size:` label (estimated implementation effort); explicit acceptance criteria. The acceptance column above is the seed for each issue's criteria block.

---

## 10. Explicitly Deferred (v1.5+)

These were considered and intentionally cut from v1 scope. Captured here so future readers do not relitigate the scope decisions.

- **`goals` table.** Tags carry us until the backlog is real. Revisit when a meaningful cluster of tasks shares a durable label across multiple weeks of operation.
- **Autonomous task generation from inferred needs.** Curia inferring tasks from quiet signals — for example "no recruiter contact in 21 days → create a task." Possible later. v1 agents create tasks only for work they actually uncovered.
- **First-class `commitments` entity.** A commitment ("Steve promised the deck by Friday") is modeled as a task with `owner='external'` + `waiting_on_contact_id`. Graduate to a first-class entity only if the abstraction starts groaning.
- **DAG dependencies.** Single `blocked_by_task_id` is enough for v1.
- **Weighted progress rollup.** No `goals` → no rollup.
- **Explicit `ceo-add-task` skill.** Coordinator prompt handles CEO entry via `task-create` for v1.
- **Interactive digest controls (snooze / done / reassign).** Read-only digest in v1; interactivity can come later if usage warrants.
- **Revisit `intent_anchor`-based drift detection.** The scheduler's `intent_anchor` / linked-tasks mechanism (spec 07, pre-existing) creates a `tasks` row for drift-detection bookkeeping on persistent recurring jobs. No agent YAML schedule entries currently use it. Before any do, evaluate whether the complexity is justified: drift detection could potentially be handled using only `scheduled_jobs` fields (e.g. a `stuck_at` timestamp or `paused_reason` text column) without coupling the scheduler to the tasks table at all. If the tasks table is for CEO-visible work, internal scheduler state may not belong there.

---

## 11. Verification Plan

### 11.1 Unit tests

- Each task skill (`task-create`, `task-list`, `task-update`, `task-complete`): happy path, validation errors, status-transition guards, `wake_at` round-trip.
- Migration up/down on a fresh Postgres and on a snapshot of the existing schema.
- Dispatch branching for task-bound vs non-task-bound `scheduled_jobs` rows.

### 11.2 Integration tests

- End-to-end wake-up: `task-create wake_at=now+10s` → scheduler fires after 10s → source agent receives fire with task context → agent calls `task-update` → task state reflects the work.
- Cancellation cascade: `task-complete` cancels the linked pending `scheduled_jobs` row.
- Sweep behavior: with 10 seeded open tasks, the sweep run advances 1–3 of them and leaves the rest untouched.
- Digest rendering: snapshot test across all three sections with realistic data, including the `+N more` truncation case.

### 11.3 Smoke tests (GPT-4o judge, HTML reports — existing framework)

- "Nathan, remind me to email Steve Friday at 9am" → task row created with `owner='ceo'`, `source='ceo'`, and a paired `scheduled_jobs` row with matching `task_id` and `run_at` aligned to Friday 9am in the CEO's timezone.
- "What's open?" → digest-shaped reply derived from `task-list`, grouped by owner.
- "Mark the Acme task done" → resolved via `task-list` lookup, then `task-complete`, with the right audit trail.
- Backlog sweep dry-run in a staging environment: verify 1–3 tasks are advanced sensibly per fire.

### 11.4 Manual verification

- Run the migration against a copy of prod data; spot-check that existing persistent agent tasks still load and resume correctly post-rename.
- Watch `meeting-debrief` for a full day after migration (item 6) and confirm pending debriefs show up in the next digest as CEO-owned tasks.
- Confirm 1309+ existing tests remain green after each issue lands.

---

## 12. New / Modified Files Summary

### New

| File | Purpose |
|---|---|
| `src/db/migrations/NNN_promote_agent_tasks_to_tasks.sql` | Rename, drop back-FK, add columns and indexes per §2 |
| `src/db/queries/tasks.ts` | Replaces `agent-tasks.ts` query module; adds task CRUD + linked-schedule queries |
| `skills/task-create/` | Manifest + handler + unit tests |
| `skills/task-list/` | Manifest + handler + unit tests |
| `skills/task-update/` | Manifest + handler + unit tests |
| `skills/task-complete/` | Manifest + handler + unit tests |

### Modified

| File | Change |
|---|---|
| `src/scheduler/runner.ts` (or equivalent dispatch module) | Branch on `scheduled_jobs.task_id`; route task-bound fires to `source_agent_id` |
| `agents/coordinator.yaml` | Pin four new skills; add `backlog-sweep` declarative job; add three prompt additions per §4.3 |
| `src/digests/pending-actions-digest.ts` | Three new sections per §6 |
| `agents/meeting-debrief.yaml` + `src/agents/meeting-debrief/*` | Migrate `pendingDebriefs` / `judgedEvents` to tasks (issue 6) |
| `src/bus/events.ts` | Add `task.created | task.updated | task.completed` discriminated union variants for audit + future subscribers |
| `config/default.yaml` | Optional `tasks.backlogSweepCron` and `tasks.sweepBatchSize` keys with defaults |
| `CHANGELOG.md` | Entries under `[Unreleased]` for each PR per CLAUDE.md |

---

## 13. Open Questions

These do not block authoring or implementation but should be answered before issue 3 lands:

1. **Sweep timezone.** The coordinator runs in a single timezone (the CEO's). The cron `0 7,13,19 * * *` is wall-clock-local in that timezone. Confirm the existing scheduler timezone handling (per spec 07 migration 012) makes this automatic.
2. **Audit-event shape.** The new `task.*` events on the bus should follow the existing audit envelope conventions. Spot-check against `src/bus/events.ts` when implementing.
3. **Backfill of existing `agent_tasks` rows.** At migration time, existing rows will get `title` defaulted from `intent_anchor` (truncated), `owner='curia'`, `source='agent'`, `source_agent_id` from `agent_id`. Confirm this default is acceptable; otherwise a one-time data migration step is needed.
