# Implementation plan — woken/derived task authorization, step 1 (#1125)

Design note: `docs/wip/2026-06-22-woken-task-authorization-design.md`. This is the
**foundation** issue; #1126 (redefine `elevated`, reclassify skills) and #1127 (console
originator stamping) build on it.

## Goal

Persist `TaskOriginator` (lineage) on the `tasks` row, thread it through the heartbeat
wake path, and introduce the **score-keyed bypass ladder** that computes *effective
standing* at skill-invocation time. The ladder is wired into the autonomy-gate
principal-bypass and the `elevated` gate's *input* — the gate's *requirement* stays
principal-or-system in this issue (the live-principal redefinition is #1126).

## Model

- **Lineage** — `tasks.originator`, immutable, copied from the creating event's
  originator at task creation; child tasks copy the parent's lineage, never upgraded
  above the parent. Pure audit + ceiling.
- **Effective standing** — computed at invocation from `(lineage, live score, execution
  context)`. The score can only ever *downgrade* lineage standing to `agent`
  (propose-only) for non-live (woken) executions; never upgrade.
- **Bypass ladder** (thresholds tunable; defaults 70 / 90):
  - `< sameTaskThreshold` (70): same-task heartbeat wake → downgrade to agent.
  - `>= sameTaskThreshold` (70): same-task heartbeat wake keeps lineage; derived child → agent.
  - `>= derivedChildThreshold` (90): same-task wake **and** derived child keep lineage.

## Execution-context detection

- A heartbeat wake is the only path that carries a `wakeContext` marker in the agent.task
  metadata (set by `fireJob` when firing an `enqueueTaskWake`-minted job). A *live* turn
  (principal inbound, scheduler-create fire, etc.) carries no `wakeContext`, so effective
  standing == lineage (unchanged behaviour).
- `derived` (which ladder column applies) is a structural property of the woken task,
  computed at wake-selection time: `source = 'agent' OR parent_task_id IS NOT NULL`. The
  dedup review task (`contact-find-duplicates`, `source='agent'`) is therefore a derived
  child; a coordinator/ceo-sourced open task with no parent is same-task.

## Changes

1. **Migration 065** — `ALTER TABLE tasks ADD COLUMN originator JSONB;` (nullable;
   pre-migration rows null → treated as agent / no-bypass).
2. **`src/autonomy/effective-standing.ts`** (new) — `BypassLadderConfig`,
   `DEFAULT_BYPASS_LADDER`, `WakeContext`, `computeEffectiveTaskMetadata()`,
   `makeWakeContext()`.
3. **`src/contacts/principal.ts`** — `capOriginatorToParent()` / `lowerStandingOriginator()`
   for child-lineage capping.
4. **`src/db/queries/tasks.ts`** — add `originator` to row types + `mapTaskRow`;
   `selectHeartbeatCandidates` returns `originator` + `derived`.
5. **`src/db/task-repo.ts`** — `CreateTaskParams.originator`; `createTask` writes the
   (parent-capped) originator; `TASK_COLUMNS` includes it.
6. **`src/scheduler/scheduler-service.ts`** — `enqueueTaskWake` accepts `originator` +
   `derived`, writes originator JSONB + `standing.derived` into task_payload.
7. **`src/scheduler/backlog-heartbeat.ts`** — pass originator + derived through.
8. **`src/scheduler/scheduler.ts`** — `fireJob` stamps `metadata.wakeContext` for
   task-wake jobs that carry an originator.
9. **`src/skills/execution.ts`** — hoist autonomy-config fetch; compute
   `effectiveTaskMetadata`; wire into the elevated gate input + the principal-bypass +
   Gate C. Audit logs keep raw lineage. New `bypassLadder` constructor option.
10. **Config** — `autonomy.bypass_ladder.{same_task,derived_child}` in default.yaml +
    `config.ts` type + `index.ts` wiring.
11. **Skills** — `task-create` + `contact-find-duplicates` pass
    `ctx.taskMetadata?.originator` to `createTask`.

## Tests

- Unit (`effective-standing.test.ts`): ladder truth-table across postures A/B/D for
  principal + system lineage, same-task vs derived, live-turn passthrough, downgrade on
  missing score.
- Unit (`principal.test.ts`): capping never exceeds parent.
- Unit (`execution.test.ts`): heartbeat-wake principal task keeps bypass at >=70, loses
  it at <70; effective standing from live score; elevated gate input uses effective
  standing.
- Unit (`task-repo` / `tasks` queries): originator written + read; heartbeat candidate
  returns originator + derived.
- Integration (#1060 dedup): system-lineage derived review task woken — elevated skill
  blocked < 90 (downgraded), allowed >= 90 (system retained).
