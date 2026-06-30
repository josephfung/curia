# 20 — Resumable Tasks & Projects

**Date:** 2026-06-30
**Status:** Shipped (Phases 0–2)
**Builds on:** [spec 19 — Tasks & Backlog](19-tasks-and-backlog.md), [spec 07 — Scheduler](07-scheduler.md), [spec 14 — Autonomy Engine](14-autonomy-engine.md), [spec 01 — Memory System](01-memory-system.md)

## Overview

Spec 19 gave the platform a durable place to track work. It did not solve **work that
exceeds a single executor invocation**. A specialist sized as a lightweight heartbeat
(`max_turns: 25`) that is handed an unbounded job (audit ~1,300 follows, read 40 docs,
dedupe 500 contacts) runs out of turns mid-work; the budget-hit was reported to the
coordinator as "didn't respond," which it confabulated into an external API timeout and
then blind-retried 51 times over 5 hours, leaving an orphaned subtask the heartbeat
re-poked indefinitely.

This spec describes the resumable-task model that fixes that class of failure. The spine
is one idea: **a goal becomes a plan, progress is tracked as "X of Y done," and resumption
advances the frontier until done.** Both quantitative sweeps ("process 1,300 follows") and
qualitative goals ("design the kickoff with the 6 execs") are the same thing at the right
altitude — a planner breaking a goal into trackable units. The only thing that
distinguishes "kinds" of work is **materialization**: ~10 heterogeneous steps of a kickoff
become child task rows; a 1,300-item sweep stays a single leaf that loops over a cursor (no
row per item).

Two principles shaped it:

- **(A) No project foresight in agent authors.** You write a generic `social-media` agent;
  you never anticipate a follow-audit. The structure of a project is decided at runtime by
  the LLM through generic harness primitives, steered by platform guidance, and *guaranteed*
  by a deterministic safety-net — never by author-declared iteration.
- **(B) Materialization is the only reason to distinguish kinds of work.** A planned step
  becomes a real child row (dispatchable, blockable, schedulable). A high-count homogeneous
  step is one leaf with a cursor. One progress notion, one resume loop.

**Companion design docs:** [2026-06-23-resumable-tasks-and-projects-design.md](../wip/2026-06-23-resumable-tasks-and-projects-design.md),
[2026-06-26-agent-document-workspace-okf-design.md](../wip/2026-06-26-agent-document-workspace-okf-design.md),
[ADR-024 — `plan` writes rows directly](../adr/024-plan-rows-direct.md). Tracking epic: #1150.

---

## 1. The resumable-execution contract

An executor invocation returns one of three outcomes (`src/agents/resumable-task.ts`):

| Outcome | Meaning | Effect |
|---|---|---|
| `done` | Work complete | Task → `done`; carries the final summary/deliverable |
| `paused` | Real progress made, more remains | Task stays `in_progress`; checkpoint persisted; continuation scheduled. **Success at the delegation layer, not a timeout.** |
| `failed` | Genuine error | Carries a structured `reason` (`budget_max_turns`, `tool_error`, `api_error`, `blocked`) and `retryable: bool`, propagated honestly upward |

`paused` **reuses the existing `in_progress` status** — no new task status, no schema churn.
It is signalled through the `EXECUTION_PAUSED_PROTOCOL` marker on the `agent.response`
(`buildExecutionPausedResponse` / `parseExecutionPausedPayload`). The delegate layer treats
`paused` as success (no re-delegation); `failed{retryable:false}` escalates without blind
retry; `failed{retryable:true}` gets a bounded retry then escalates (`DelegationGuard`,
`src/agents/delegation-guard.ts`). This ends the confabulation: the coordinator now receives
`failed{reason: budget_max_turns}` and reports the truth.

## 2. Resumable state — the `progress.resumable` block

Resumable state lives in the existing `tasks.progress` JSONB under a `resumable` block (no
migration), defined and bounded in `src/db/resumable-progress.ts`:

- `cursor` (opaque, LLM-authored), `done` / `total`, `lastSliceUnits`, a one-line `next`,
  `checkpointedAt`, and an `accumulator`.
- The accumulator is **bounded**: an inline cap (4 KB) and an overall block cap (8 KB). On
  overflow it spills to the document workspace (`working_documents`, spec 01 / OKF design)
  and the block stores a `{ kind: 'document', path, section? }` pointer instead.

`TaskRepo.getResumableBlock` / `setResumableBlock` are the only read/write path; writes
publish `task.updated` for audit. A task is "resumable" when `error_budget.resumable=true`,
a `resumable` tag is present, or a checkpoint already exists (`isResumableTask`).

## 3. Checkpointing — a harness guarantee, not an author convention

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

## 4. The resume loop & circuit-breaker

A `paused` task schedules its **own near-term continuation** wake (`scheduled_jobs`,
default `tasks.resumableContinuationSeconds: 30`) routed to its `source_agent_id`
(`src/agents/resumable-continuation.ts` + `resumable-continuation-subscriber.ts`), rather
than waiting for the hourly `BacklogHeartbeat`, which remains the backstop. A partial unique
index (migration 067) enforces at most one active wake per task.

The circuit-breaker keys on **progress, not error count** (`src/agents/resumable-circuit-breaker.ts`,
state in `progress.resumableCircuit`). A continuation that makes no forward progress (cursor
unchanged and done-count flat) increments a stall counter; after K stalls, or on breach of a
hard per-task ceiling, the task is failed and escalated via the existing `needs-attention`
backlog path. Defaults (`tasks.resumableCeilings`): `maxStalls: 3`, `maxIterations: 100`,
`maxWallclockHours: 24`, `maxCostUsd: 10`; each is overridable per task through the
`error_budget` keys validated in `src/tasks/task-error-budget.ts` (per #883: per-task keys
only — per-invocation `max_turns`/`max_errors` belong to agent config and are rejected on
task rows).

## 5. The `plan` primitive

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

## 6. Frontier advancement, reconciliation, and the deliverable

- **Frontier advancement** (`PlanFrontierSubscriber`, `src/agents/plan-frontier.ts`). When a
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

## 7. Promoting the deliverable to the knowledge graph

On a planned parent's completion, `DeliverableKgPromotionSubscriber`
(`src/agents/deliverable-kg-promotion.ts`) distils the **curated deliverable** (never the
per-item worklog) into the KG through the existing `extract-facts` / `extract-relationships`
gates — typed, source-attributed, and **capped per project** (`documentWorkspace.kgPromotion`:
`maxFacts: 50`, `maxRelationships: 50`). Promotion is **best-effort and non-fatal**
(fire-and-forget with a catch; it can never fail the parent's completion), is disableable
globally or per task (`error_budget.kg_promotion: false`), and archives the project's
workspace docs (`archived_at`) afterward.

## 8. Configuration

```yaml
tasks:
  resumableContinuationSeconds: 30   # near-term continuation cadence (vs. hourly heartbeat)
  resumableCeilings:
    maxStalls: 3                      # K consecutive no-progress continuations → escalate
    maxIterations: 100               # hard cap on continuation slices
    maxWallclockHours: 24            # elapsed cap from first pause
    maxCostUsd: 10.00                # aggregate LLM cost cap across slices

documentWorkspace:
  kgPromotion:
    enabled: true
    maxFacts: 50
    maxRelationships: 50
```

Per-task overrides live in `tasks.error_budget` (`resumable`, `max_stalls`, `max_iterations`,
`max_wallclock_hours`, `max_cost_usd`, `kg_promotion`).

## 9. Relationship to spec 19

This spec supersedes several items spec 19 §10 deferred: durable multi-step projects with a
weighted progress rollup (the `progress.plan` "X of Y"), and decomposition with dependencies.
The single-`blocked_by_task_id` DAG limitation, a first-class `goals`/`commitments` entity,
an LLM groomer, and an interactive digest surface remain deferred (spec 19 §10). Everything
here reuses spec 19's `tasks` + `scheduled_jobs` + heartbeat — no parallel "project runner"
subsystem was introduced (explicitly rejected in the design memo).
