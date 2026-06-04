# Design: Task Execution & Heartbeat (v1)

**Status:** Design, pre-implementation
**Date:** 2026-06-04
**Builds on:** [2026-06-01-tasks-and-backlog-design.md](2026-06-01-tasks-and-backlog-design.md) (Tasks & Backlog v1 — `tasks` table, `task-*` skills, digest backlog sections, per-task wake routing)
**Supersedes / rescopes:** §4.2 (`backlog-sweep`) of the 2026-06-01 doc; rewrites issue [#840](https://github.com/josephfung/curia/issues/840)

---

## Context

Tasks & Backlog v1 shipped the *storage and read* half of the system: the `tasks` table (migration 049), the four `task-*` skills, the digest's backlog sections (#838), the tasks console UI (#876), and the per-task wake-up routing in the scheduler (`scheduled_jobs.task_id` → dispatch to `source_agent_id` with task context). What it did **not** ship is the *execution* half. The `backlog-sweep` declared in §4.2 of that doc was never built — the migration even left an index comment referencing it (`tasks_open_priority_idx: backlog sweep and digest queries`), but no job advances open work.

The result is three operational failure modes:

1. **Everything-at-once (worry A).** Agents try to finish multi-step work in a single burst — burning execution budget and losing context across the turn. `ceo-inbox` is the worst case: it triages the *entire* unread backlog oldest-first in one run, with no decomposition, no prioritization, and no deferral. The only backstop is the `error_budget` cliff, which produces *partial* work with no graceful handoff.

2. **Lingering work (worry B).** A task created with `owner='curia'` and no `wake_at` never advances unless the CEO pokes it. There is no heartbeat. Visibility (the digest) is not stewardship — the system *shows* open work but never *acts* on it autonomously.

3. **Dangling commitments (a costly variant of A+B).** An agent emits a forward promise into an artifact — e.g. a draft reply that says "the CEO will follow up later with the document" — with **nothing tracking the promise**. Once that artifact is sent, the loop is silently open forever. The CEO never learns something was outstanding.

The ambition is larger than "drain a backlog." We want Curia to **devise a work plan for a multi-step project and execute it incrementally** — advancing what it can, parking the rest behind something that will wake it, and never abandoning a commitment. The motivating example: *"book a sales kickoff with my head of sales and the whole sales team"* decomposes into plan-agenda-with-the-sales-leader → confirm-roster-and-calendars → book-venue → send-invites, where some steps are doable now, some are blocked on a human, and some are blocked on a prior step.

---

## Goals & Non-Goals

### Goals (v1)

- A **deterministic hourly heartbeat** that guarantees no open work lingers — a cheap, frequent router, not an LLM job.
- A **shared task-management capability** turned on by a single declarative flag (`enable_task_management`), bundling the task skills + a uniform executor-discipline prompt block + heartbeat eligibility — defined **once in code** so custom agents cannot drift.
- The **advance-until-blocked** execution loop and the **no-dangling-commitment** invariant, applied uniformly to every participating agent.
- First-class **project decomposition** (parent task + first-wave subtasks + `blocked_by` ordering).
- `ceo-inbox` **joins the system**: closes its document-follow-up failure mode (reification + resume) *and* sheds load on a backed-up inbox (the original #840 scope).

### Non-goals (v1)

- The **LLM groomer** — a periodic holistic pass that dedupes, re-prioritizes, and promotes clusters to projects. A clean seam is left; it is explicitly not built. We want to observe real failure modes first.
- Autonomous task generation from inferred needs ("no recruiter contact in 21 days").
- New schema columns (target: **zero**; one contingency column noted in §9).
- Any change to the autonomy engine — we *lean on it* unchanged (§7).
- A new UI surface or channel.

---

## 1. Architecture Summary

The machine in one breath: **a task-owning agent, when it gets work it cannot finish in one shot, decomposes it, advances it until it hits a real blocker or its burst budget runs low, then parks each loose end as a task with the right status and a wake condition. The work comes back to life through one of three channels — an event, a per-task timer, or the heartbeat — and the owning agent resumes exactly where it left off.** Nothing is ever finished by abandonment; a task is either `done`, or parked behind something that will wake it.

Two roles, cleanly split:

- **The heartbeat is the conductor; it never plays an instrument.** One deterministic, code-only loop runs hourly, decides *which agents* have idle or stale work, and routes a single wake to each. It does no domain reasoning.
- **Execution is distributed to owners.** The actual advancing of a task happens inside the owning agent's resume burst, governed by the LLM and bounded by that agent's `error_budget`.

### 1.1 Data flow

```
  ┌─────────────┐   reads tasks,        ┌────────────────┐  reads scheduled_jobs,   ┌──────────────┐
  │  HEARTBEAT  │   writes one-shot     │   SCHEDULER    │  dispatches with         │ OWNER AGENT  │
  │ (hourly,    │──▶ scheduled_jobs ───▶│  (polls 30s,   │──▶ task context ────────▶│ (resume burst│
  │  code-only) │   rows (run_at=now)   │   unchanged)   │  to source_agent_id      │  executes)   │
  └─────────────┘                       └────────────────┘                          └──────────────┘
```

This preserves the separation the 2026-06-01 doc was careful about (§1.1 there): **the scheduler reads only `scheduled_jobs`, never `tasks`.** The heartbeat is a *new, separate* system component that reads `tasks` and *produces* `scheduled_jobs` rows. The scheduler remains a pure consumer of `scheduled_jobs`. The heartbeat hands work off by inserting one-shot wake rows — reusing the entire existing dispatch path that already ships.

### 1.2 What this replaces

The 2026-06-01 §4.2 `backlog-sweep` was an **LLM coordinator cron job, 3×/day, that itself picked and advanced 1–3 tasks**. We replace it because (a) it is too coarse for projects, (b) it conflates *routing* with *doing*, and (c) it is itself a recurring burst of action — re-introducing worry A at the system level. The new heartbeat separates the cheap deterministic routing (hourly) from the bounded LLM execution (per-agent, on wake).

---

## 2. Reactivation Model

A parked task returns to life through three layers, fastest to slowest. The fast layers carry the common case; the heartbeat is the backstop.

1. **Event (instant).** An inbound reply or a provided document wakes the blocked task immediately via the existing `context-bridge` / active-outbound-context mechanism. When the head of sales replies, "finalize agenda → unblock venue → book venue" happens in seconds, event-chained, with no cron involved. This is the primary driver for in-flight projects.

2. **Per-task `wake_at` (precise).** The owner sets it when parking — "nudge the sales leader in 3 days if silent." Stored as a one-shot `scheduled_jobs` row (the `wake_at` convenience already in `task-create` / `task-update`). Event-cancellable: if the reply lands first, the wake is cancelled.

3. **Heartbeat (catch-all).** The backstop for when an agent *forgot* to set a wake, or a task got orphaned. This is what guarantees nothing lingers (worry B) even when an agent misbehaves.

Cron frequency is almost irrelevant to how responsive a project *feels* — events and advance-until-blocked drive responsiveness. The heartbeat exists only for stalls, which is why it can be cheap and hourly.

---

## 3. The Heartbeat (deterministic enqueuer)

A **new system-level component** (`BacklogHeartbeat`), started in `src/index.ts` alongside the other System-layer infrastructure, with its own hourly tick. On each tick it runs one deterministic selection query over `tasks` and inserts one-shot `scheduled_jobs` wake rows. It performs **no LLM work and no domain reasoning**.

### 3.1 Selection logic: pick the agent, not the task

The heartbeat wakes an **agent**, not a task. Per tick, for each `source_agent_id` it selects that agent's single most-deserving candidate as the *entry point* and enqueues exactly one wake. Two protections against bursty over-wake stack here:

- **Layer 1 — `blocked_by` keeps ordered chains out of the candidate set.** A properly decomposed sequence (#1 → #2 → #3) exposes only its *head*; successors carry a `blocked_by_task_id` and are excluded by definition until their blocker is `done`/`cancelled`. In-project ordering is protected by the dependency field, not by the heartbeat being clever.
- **Layer 2 — one wake per agent per tick.** The residual risk is an agent owning many *independent* unblocked tasks (e.g. `ceo-inbox` with 8 deferred replies). One-per-agent caps this: the woken agent pulls its own `task-list` and advances several of its tasks in that single burst, **in the dependency order it knows**, bounded by its `error_budget`. The heartbeat never needs to understand sequencing because it never picks more than one entry point per agent.

A **global cap** (`heartbeatMaxWakesPerTick`, default 5) backstops the day there are many agents: if more than 5 agents have idle work, take the 5 with the most-overdue entry points; the rest wait an hour.

Two candidate populations, both characterized by *"not done/cancelled, no pending wake, gone quiet"*:

| Population | Predicate | On wake, the owner… |
|---|---|---|
| **Idle-unblocked** | `owner='curia'`, `status IN ('open','in_progress')`, unblocked, no pending wake, `updated_at` older than `idleThresholdHours` (default **4h**) | advances the work (advance-until-blocked) |
| **Orphaned wait** | `status IN ('waiting','blocked')`, no pending wake, `updated_at` older than `staleWaitThresholdHours` (default **48h**) | re-evaluates: nudge the human, escalate to the CEO, or re-park with a proper `wake_at` |

The two thresholds differ deliberately: an in-flight task should be poked within half a workday, but you do not re-ping a human 4h after emailing them. The orphaned-wait row is a *safety net for a forgotten timer* — a well-behaved agent would have set its own `wake_at`, which fires first.

### 3.2 Selection query (sketch)

```sql
-- One entry-point task per eligible agent, globally capped, most-overdue first.
SELECT DISTINCT ON (t.source_agent_id) t.id, t.source_agent_id
FROM tasks t
WHERE t.status IN ('open','in_progress','waiting','blocked')
  AND t.source_agent_id = ANY ($1)                 -- only task-management-enabled agents
  -- not blocked by an unfinished task
  AND (t.blocked_by_task_id IS NULL OR EXISTS (
        SELECT 1 FROM tasks b WHERE b.id = t.blocked_by_task_id
          AND b.status IN ('done','cancelled')))
  -- no pending wake already scheduled (respects agent-set wake_at and prior heartbeat enqueues)
  AND NOT EXISTS (
        SELECT 1 FROM scheduled_jobs sj
        WHERE sj.task_id = t.id AND sj.status = 'pending')
  -- quiet past the per-status threshold
  AND (
        (t.owner = 'curia' AND t.status IN ('open','in_progress')
           AND t.updated_at < now() - ($2 || ' hours')::interval)
     OR (t.status IN ('waiting','blocked')
           AND t.updated_at < now() - ($3 || ' hours')::interval)
      )
ORDER BY t.source_agent_id, t.updated_at ASC        -- per agent: oldest-touched = most deserving
-- application layer then takes the top N (=5) of these by lateness and enqueues one wake each
```

For each selected task the heartbeat inserts a `scheduled_jobs` row: `run_at = now()`, `task_id = <task>`, `agent_id = source_agent_id` (falling back to `coordinator` if that agent is disabled), `created_by = 'heartbeat'`, and a short `task_payload` ("Resume and advance this task"). The existing scheduler fires it within 30s.

### 3.3 Why `updated_at` is sufficient (for now)

"Idle" = `updated_at` age; "expected wait" = an owner-set `wake_at` (a pending `scheduled_jobs` row, which the `NOT EXISTS` guard respects); "stale" = no such wake and quiet past threshold. All three are expressible from existing `tasks` fields plus `scheduled_jobs`. **No new columns.** Contingency: if `updated_at` proves a noisy proxy for "last actually advanced" (e.g. a label/tag touch bumps it spuriously), add a single `last_advanced_at` column — flagged, not built (§9).

---

## 4. The Executor Loop & the No-Dangling-Commitment Invariant

These are *behavioral* rules shared by every participating agent. They live **once** in the injected `task_management` prompt block (§6), not copy-pasted per agent.

### 4.1 The loop

When an agent receives or resumes a task, it runs:

1. **Advance until blocked.** Do every step you can right now. Stop only at a genuine blocker — waiting on a person, on the CEO's approval, on a future date, or on a prior task — **or** when your burst budget (`error_budget`: `max_turns` / `max_cost_usd`) runs low. This bound is what prevents the runaway burst (worry A). On a heartbeat wake you may pull your other owned, ready tasks via `task-list` and advance them too, in dependency order, until blocked or budget-bounded.
2. **Reify before you promise** (§4.2).
3. **Park cleanly.** For each loose end, set status (`waiting` / `blocked`), append a `progress_note`, and set a wake — an event bridge (so a reply reactivates it) *or* a `wake_at` timer (so silence reactivates it). Setting neither is permitted (the heartbeat catches it) but setting one is the discipline.

### 4.2 The invariant

> **No outbound artifact may contain an unfulfilled forward commitment unless a task backs that commitment — and the agent prefers to fulfill the commitment *before* sending.**

This is the rule that kills the dangling-document failure. The agent decomposes the reply: "respond to sender" is `blocked_by` "obtain the document." Because advance-until-blocked cannot reach the "send reply" step until "obtain document" completes, the agent's **default** behavior is to resolve first and send a *complete* reply. The three outcomes the CEO articulated fall out at runtime depending on whether the dependency resolves, and they map to the CEO's stated preference order:

| Outcome | When | Mechanism |
|---|---|---|
| **Resolve-then-reply** (most preferred) | the doc is findable now or after a short wait | reply step stays `blocked_by` obtain-doc; the promise is never made; a complete reply is sent once resolved |
| **Promise-then-self-fulfill** | sender needs acknowledgment now; Curia can chase the doc | send interim reply **+** create follow-up task `owner='curia'`; resume wakes Curia to send the doc |
| **Promise-then-CEO-owns + notify** (fallback) | sender needs acknowledgment now; only the CEO can produce the doc | send interim reply **+** create follow-up task `owner='ceo'` **+** notify the CEO; appears in the digest's "For you to do" |

There is no configuration choosing among these — the agent picks at runtime. *How hard Curia tries to resolve before falling back* is governed by its autonomy posture (§7), not new logic.

---

## 5. Decomposition: Projects

A "project" is a durable goal with a small dependency graph. The rule of thumb, baked into the `task_management` block:

> **If the work has more than one step, or any step cannot be completed right now, create a parent task (`intent_anchor` = the durable goal) plus the *first wave* of subtasks (`parent_task_id`, with `blocked_by_task_id` for ordering). Otherwise, a single task.**

- **Plan the first wave, not the whole tree.** Add subtasks as reality reveals them — the sales leader's agenda determines the venue size, which could not have been planned up front. Incremental planning beats a brittle complete plan.
- **Cross-specialist ownership.** For a project spanning specialists, the **coordinator** owns the parent (`source_agent_id='coordinator'`). Subtasks may carry different `source_agent_id`s (a "confirm calendars" subtask → calendar specialist; "draft agenda" → coordinator) so each wakes the right owner.
- **Parent completion.** When a subtask completes and unblocks the next, the resuming owner advances the chain. The parent task is itself heartbeat-eligible: once its children are done and it is idle-unblocked, the heartbeat wakes its owner to close it out (or advance the next wave). No special parent-rollup machinery in v1.

### 5.1 Walkthrough: the sales kickoff

1. **Intake (synchronous):** coordinator recognizes a multi-step request → creates parent `intent_anchor:"book sales kickoff"` + first-wave subtasks → advances what it can now (messages the sales leader to plan content; pulls roster + candidate calendar windows) → parks the rest (`waiting` on the sales leader; `blocked_by` agenda) → tells the CEO "kicked it off, I'll keep moving as pieces come back."
2. **Sales leader replies (event):** wakes the agenda subtask → finalize agenda → unblocks venue → propose/book venue (escalates if it spends money, per §7) → park on approval.
3. **Venue confirms (event):** unblocks invites → send calendar invites → parent nears `done`.
4. **Heartbeat's role here:** *none of the driving* — events do that. It only intervenes if, say, the sales leader never replies and the agent forgot a nudge timer (orphaned wait → wake coordinator to nudge or escalate at 48h).

---

## 6. The `enable_task_management` Agent Capability

The §4–§5 rules are *behavioral discipline*. Injecting them by hand into each agent prompt guarantees drift the moment someone hand-builds a custom agent. Instead, a single declarative toggle on the agent YAML bundles the whole capability — mirroring existing per-agent capability flags (`inject_specialists: true`, `memory: scopes: [...]`, the runtime autonomy-block injection).

```yaml
# agents/<name>.yaml
enable_task_management: true   # default: false
```

When `true`, the agent runtime does three things:

1. **Auto-pins** `task-create`, `task-list`, `task-update`, `task-complete` (merged and deduped with the agent's explicit `pinned_skills`).
2. **Auto-injects** the single `task_management` guidance block — the §4 executor loop, the §4.2 reification invariant, the §5 decomposition rule, and the resume-mode contract — at a **fixed slot** in the effective system prompt (after the identity / security blocks). A fixed slot, not a `${placeholder}`: for a discipline block, "flag set true but author forgot the placeholder" would reintroduce exactly the inconsistency we are eliminating. Guaranteed presence beats placement control.
3. **Marks the agent heartbeat-eligible** — only enabled agents appear in the heartbeat's `source_agent_id` allow-list (§3.2, `$1`) and need a resume mode (the block supplies it).

Notes:

- **Default `false`, opt-in `true`.** Enable on the agents that uncover deferrable work: `coordinator`, `ceo-inbox`, `meeting-debrief`, `research-analyst`. Leave off pure-CRUD specialists (`contacts`, `calendar`) that act-and-return.
- **Manual import escape hatch.** An agent may still list individual `task-*` skills in `pinned_skills` without the flag, for a bespoke need (e.g. read-only `task-list` access) — the flag is a convenience bundle, not the only path. Such an agent is *not* heartbeat-eligible and gets no injected block.
- **Disabled-owner fallback.** If a task's `source_agent_id` points at an agent that is *not* task-management-enabled (or is null), the heartbeat routes the wake to the **coordinator** — the same fallback the 2026-06-01 doc specifies for null owners.
- **Versioning.** The `task_management` block is platform code, versioned with the platform; every opted-in agent gets the identical, current rules. Bumping the block is a platform change, surfaced in structured logs (per CLAUDE.md versioning conventions).

### 6.1 The injected block (proposed content)

> **Task management.** You can defer, track, and resume work using your task skills.
>
> **Decide, don't drop.** When work arrives that you cannot finish now, create a task (`task-create`, optionally with `wake_at`) rather than cramming or abandoning it. Briefly tell the CEO what you queued and why.
>
> **Decompose projects.** If work has more than one step, or any step cannot be done right now, create a parent task whose `intent_anchor` states the durable goal, plus the first wave of subtasks (`parent_task_id`, `blocked_by_task_id` for ordering). Plan the first wave only; add subtasks as you learn more.
>
> **Advance until blocked.** When you act on a task, do every step you can right now. Stop only at a real blocker — waiting on a person, on the CEO's approval, on a future date, or on a prior task — or when your turn budget runs low. Then park each loose end: set its status (`waiting`/`blocked`), add a progress note, and set a wake (a reply you're expecting, or a `wake_at` timer).
>
> **Never promise without a task.** Before you send anything that commits to a future action ("I'll follow up with X", "we'll send that over"), make sure a task backs that promise. Prefer to *resolve the dependency first* and send a complete message. Only send an interim "I'll follow up" when the recipient needs an acknowledgment now — and when you do, create the follow-up task (yours if you can chase it; the CEO's if only they can, and tell them).
>
> **Resuming.** When you're woken to advance a task, you'll receive its id, title, intent, and progress. Pick up where you left off. You may pull your other ready tasks (`task-list`) and advance them too, in dependency order, until blocked or budget-bound.

---

## 7. Autonomy Interaction

The hybrid "execute the safe stuff, escalate the rest" line is **already governed by the existing autonomy engine** (spec 14) — `action_risk` on each skill against the live autonomy score. The executor loop inherits this for free:

- "Draft the agenda" (`action_risk` low/none) → just do it.
- "Email the sales leader" (`medium`, outbound) → gated by score.
- "Book the $4k venue" (`high`/`critical`) → escalates to the CEO via the existing pending-approval flow.

So *how forward-leaning the steward feels* is tuned by the CEO's autonomy posture (`get-autonomy` / `set-autonomy`), **not** by new risk logic in this design. This design adds zero new autonomy mechanics; it composes with what exists.

---

## 8. Agent-by-Agent Changes

| Agent | Change |
|---|---|
| **(platform)** | New `BacklogHeartbeat` system component + deterministic router (§3). New `enable_task_management` runtime capability + injected block (§6). |
| **coordinator** | Set `enable_task_management: true` (drops its now-redundant manual `task-*` pins). Inherits the project-execution + reification behavior via the block. Add a modest explicit `error_budget` (it has none today) so project bursts are bounded. **Remove** the never-built §4.2 `backlog-sweep` from scope (it is replaced by the heartbeat, which is *not* a coordinator cron). |
| **ceo-inbox** (#840 rewrite) | Set `enable_task_management: true` (it currently has **zero** `task-*` skills — it cannot create a follow-up task today). Add the reification rule into the NEEDS DRAFT path (the document-follow-up case). Add task-wake resume handling (when a deferred reply task wakes, draft it). **Keep** the original #840 overflow load-shedding: above N unread, process the top-priority handful inline and defer the tail as `tag='inbox-overflow'` tasks. |
| **meeting-debrief** | Set `enable_task_management: true`. Its bespoke per-agent state (`pendingDebriefs` / `judgedEvents`) was the original proof case (2026-06-01 §7) — it inherits the shared loop and the heartbeat for free. (Confirm migration status during planning.) |
| **research-analyst** | Set `enable_task_management: true` for long-running queries that should defer and resume rather than block a burst. |

---

## 9. Schema

**Target: zero new columns.** Everything the heartbeat needs is expressible from existing `tasks` fields + `scheduled_jobs` (§3.3). The status lifecycle, `owner`, `parent_task_id`, `blocked_by_task_id`, `source_agent_id`, `updated_at`, and the `wake_at`-as-`scheduled_jobs`-row convention all exist from the 2026-06-01 work.

**Contingency (flagged, not built):** if `updated_at` is too noisy a proxy for "last actually advanced" (a tag/label write bumps it without real progress), add a single `last_advanced_at TIMESTAMPTZ` column, written only by `task-update` when a `progress_note` is supplied, and switch the §3.2 thresholds to it. Decide during implementation against real data; do not pre-build.

### 9.1 Configuration

`config/default.yaml`, `tasks.*` (supersedes the 2026-06-01 `backlogSweepCron` / `sweepBatchSize`):

```yaml
tasks:
  heartbeatIntervalMinutes: 60      # hourly
  heartbeatMaxWakesPerTick: 5       # global cap; per-agent cap is always 1
  idleThresholdHours: 4             # active idle (open/in_progress, curia-owned)
  staleWaitThresholdHours: 48       # orphaned waits (waiting/blocked, no wake set)
```

---

## 10. Already Shipped vs. New

To scope the work precisely:

**Already shipped (reused, not rebuilt):**
- `tasks` table + status lifecycle + ownership columns (migration 049).
- `task-create` / `task-list` / `task-update` / `task-complete` skills, with the `wake_at` convenience.
- Per-task wake routing: `scheduled_jobs.task_id` → dispatch to `source_agent_id` with task context ([scheduler.ts](../../src/scheduler/scheduler.ts), [scheduler-service.ts](../../src/scheduler/scheduler-service.ts)).
- Digest backlog sections (#838); tasks console UI (#876).
- The autonomy engine (spec 14) and `context-bridge` reply routing.

**New in this design:**
1. `BacklogHeartbeat` system component + deterministic router + selection query (§3).
2. `enable_task_management` runtime capability: skill auto-pin + fixed-slot block injection + heartbeat-eligibility registration (§6).
3. The `task_management` prompt block content (§6.1).
4. Reification + advance-until-blocked behavior wired into `ceo-inbox` (#840 rewrite) and validated end-to-end.
5. `tasks.*` config (§9.1); coordinator `error_budget`.

---

## 11. Issue Breakdown (suggested PR sequence)

Each item is one PR, independently reviewable. Items 2 and 3 can parallelize after item 1.

| # | Issue | Acceptance |
|---|---|---|
| 1 | **`enable_task_management` capability.** Runtime flag: auto-pin task skills (deduped), inject the `task_management` block at the fixed slot, register heartbeat-eligibility. Default `false`. | Enabling the flag on a test agent makes the four skills callable and the block present in its effective prompt; a disabled agent is unchanged; manual `task-*` pins without the flag still work and do not inject the block. Typecheck + existing tests green. |
| 2 | **`BacklogHeartbeat` system component.** Hourly tick, deterministic selection query (§3.2), one-shot `scheduled_jobs` enqueue with dedup, per-agent=1 + global cap, disabled-owner→coordinator fallback. Config keys (§9.1). | Unit tests: idle-unblocked and orphaned-wait selection; `blocked_by` exclusion; `NOT EXISTS` wake dedup; per-agent=1; global cap. Integration: seed idle tasks across 3 agents → exactly one wake per agent, capped at 5, each routed to the correct `source_agent_id`. A task with an agent-set pending `wake_at` is **not** double-enqueued. |
| 3 | **Coordinator onboarding.** Flip `enable_task_management: true`, drop redundant manual pins, add `error_budget`. Remove the never-built §4.2 `backlog-sweep` from any tracking. | Smoke: "book a sales kickoff…" produces a parent task + first-wave subtasks with sensible `blocked_by`; advance-until-blocked parks on the sales-leader wait; a simulated reply event advances the chain. Existing coordinator smoke tests green. |
| 4 | **ceo-inbox: close the loop (#840 rewrite).** Flag on; reification rule in NEEDS DRAFT; task-wake resume drafting; overflow load-shedding above N unread. | The document-follow-up case: with no doc available, ceo-inbox does **not** send a bare "CEO will follow up" — it either resolves first or creates + assigns a tracked follow-up task and notifies. With > N unread in staging, top-priority handful processed inline, tail deferred as `inbox-overflow` tasks visible in the next digest. LLM time per burst no longer scales linearly past N. |
| 5 | **(Stretch) `last_advanced_at`.** Only if item 2's `updated_at` proves noisy against real data. | Column added; `task-update` writes it on `progress_note`; heartbeat thresholds switch to it; backfill from `updated_at`. |

Per CLAUDE.md, every issue needs applicable pre-existing labels, one `size:` label, and explicit acceptance criteria. Issue #840 is **rewritten** (not newly created) to item 4's scope.

---

## 12. Verification Plan

### 12.1 Unit
- Heartbeat selection query: each population, `blocked_by` exclusion, wake dedup, per-agent=1, global cap, threshold boundaries, disabled-owner fallback.
- Capability wiring: flag on → skills pinned + block injected at the fixed slot; flag off → neither; manual import path unaffected.

### 12.2 Integration
- End-to-end heartbeat: seed idle/stale/blocked tasks across multiple agents → assert exactly the expected one-shot `scheduled_jobs` rows, correct routing, and that already-waked tasks are skipped.
- Advance-until-blocked: a project task with a 3-step chain advances to the first blocker in one burst, parks, and resumes on a simulated event.
- Cancellation: completing a task cancels its pending heartbeat-enqueued wake (existing `task-complete` cascade).

### 12.3 Smoke (LLM-judge, existing framework)
- **Dangling-commitment regression:** an inbound email requesting a document Curia does not have → assert no bare "CEO will follow up" is sent without a backing task; assert the correct one of the three §4.2 outcomes.
- **Project decomposition:** "book a sales kickoff…" → parent + first-wave subtasks + sensible `blocked_by`; advance-until-blocked behavior; event-driven advancement on a simulated reply.
- **Overflow:** > N unread → top handful inline, tail deferred, digest shows them.
- **No-lingering:** an `owner='curia'` task left untouched for > 4h with no wake → the next heartbeat tick wakes its owner.

### 12.4 Manual
- Run a full day in staging with the heartbeat live; confirm hourly ticks are cheap (no LLM cost on empty ticks) and that real idle tasks get advanced without thrash.
- Confirm existing test suite remains green after each item.

---

## 13. New / Modified Files Summary

### New
| File | Purpose |
|---|---|
| `src/tasks/heartbeat.ts` (or `src/scheduler/backlog-heartbeat.ts`) | `BacklogHeartbeat` component: hourly tick, selection query, one-shot enqueue |
| `src/tasks/heartbeat.test.ts` | Unit tests for selection + enqueue |
| `src/agents/task-management-block.ts` (or template asset) | The single source-of-truth `task_management` prompt block (§6.1) |

### Modified
| File | Change |
|---|---|
| `src/index.ts` | Start `BacklogHeartbeat` in System-layer bootstrap |
| agent runtime loader (effective-prompt + skill assembly) | Honor `enable_task_management`: auto-pin skills, inject block at fixed slot, register heartbeat-eligibility |
| `agents/coordinator.yaml` | `enable_task_management: true`; drop redundant `task-*` pins; add `error_budget` |
| `agents/ceo-inbox.yaml` + `src/agents/ceo-inbox/*` | `enable_task_management: true`; reification in NEEDS DRAFT; task-wake resume; overflow load-shedding |
| `agents/meeting-debrief.yaml`, `agents/research-analyst.yaml` | `enable_task_management: true` |
| `config/default.yaml` | `tasks.*` keys (§9.1); remove `backlogSweepCron` / `sweepBatchSize` if present |
| `CHANGELOG.md` | `[Unreleased]` entries per PR |

---

## 14. Open Questions

These do not block authoring; resolve before the relevant item lands.

1. **Heartbeat trigger mechanism.** Internal bootstrap timer (`setInterval`, simplest) vs. a self-scheduling system `scheduled_jobs` row dispatched to a *code* handler (more integrated, needs the scheduler to support non-agent handlers). Lean: bootstrap timer for v1.
2. **`updated_at` noisiness.** Whether tag/label/progress-note writes bump `updated_at` enough to mask real idleness — drives whether item 5 (`last_advanced_at`) is needed. Measure in staging.
3. **Resume-burst budget for the coordinator.** What `error_budget` (`max_turns` / `max_cost_usd`) bounds a coordinator project burst without starving a legitimately deep project? Start conservative; tune against real bursts.
4. **Orphaned-wait escalation phrasing.** When a 48h orphaned wait wakes the owner, what is the default action — silent re-ping, or surface to the CEO? Lean: owner judgment per the block, biased toward a CEO nudge for `owner='ceo'`/`external`.
