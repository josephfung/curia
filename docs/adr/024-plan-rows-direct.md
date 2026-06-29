# ADR-024: Plan primitive writes child rows directly (rows-direct)

Date: 2026-06-29
Status: Accepted

## Context

Phase 2 of resumable tasks introduces the `plan(goal)` primitive: a runtime LLM
decomposes a complex goal into child steps with dependencies, assigned executors,
and a durable `progress.plan` block (#1236). The design memo left one open
question: should `plan` write child task rows directly, or propose a tree that
the coordinator commits?

Three approaches were considered:

**A. Coordinator-proposed plan.** The runtime LLM returns a proposed step tree;
the coordinator validates and calls `task-create` for each child. Rejected:
puts the decomposition loop in the layer that already confabulated on specialist
failures (#1170) and blind-retried non-retryable errors (#1171). Adds prompt
surface and latency without adding safety.

**B. Dedicated project-runner subsystem.** A parallel orchestration service
materializes and advances plans. Rejected in the design memo: duplicates
`tasks` + `scheduled_jobs` + the BacklogHeartbeat backstop.

**C. Rows-direct via `plan` skill.** The runtime LLM calls a harness primitive
that writes child rows through `TaskRepo` / `task-create` internals and persists
`progress.plan` atomically — symmetric with `checkpoint` → `setResumableBlock`.

## Decision

**`plan` writes child task rows directly** through `skills/plan/`, using
`TaskRepo.createTask` with `parent_task_id`, `blocked_by_task_id`, and
`waiting_on_contact_id`, then `TaskRepo.setPlanBlock` for the durable plan
state. The skill is pinned dynamically per-turn for complex bound tasks (not
in agent YAML), matching the checkpoint pattern (#1173).

Re-running `plan` reconciles by stable step `id`: existing children are reused,
removed steps cancel open children, lazy steps stay unmaterialized until pickup.

## Consequences

**Positive**

- Decomposition stays in the execution layer with the bound task context, not
  the coordinator prompt.
- Consistent with every shipped primitive (`checkpoint`, `task-create`,
  escalation flows).
- Adaptive re-plan is a single skill call with idempotent child reuse.

**Trade-offs**

- The `plan` skill must implement reconcile logic (duplicate prevention, removed-
  step cancellation) — more code in the skill than a coordinator-only proposal.
- Cross-agent child ownership follows `task-create` rules: invalid
  `target_agent_id` fails at skill execution time.

**Follow-ups**

- Frontier advancement (#1238) and completion reconciliation (#1239) consume
  the plan block written here; they are separate mechanisms.
