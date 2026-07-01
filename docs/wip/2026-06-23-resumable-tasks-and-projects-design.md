# Resumable Tasks & Projects — Design

**Date:** 2026-06-23
**Status:** Shipped (Phases 0–2) — promoted to [spec 20 — Resumable Tasks & Projects](../specs/20-resumable-tasks-and-projects.md). This memo is kept as the dated design record.
**Builds on:** [spec 19 — Tasks & Backlog](../specs/19-tasks-and-backlog.md), [spec 07 — Scheduler](../specs/07-scheduler.md), [spec 14 — Autonomy Engine](../specs/14-autonomy-engine.md)

## Context — the motivating failure

A principal asked the coordinator to audit ~1,300 Bluesky follows: page through them,
unfollow the obvious ones, and email back the ones flagged for review. The coordinator
built a sound shape (parent task + batch subtasks) and delegated batch 1 to the
`social-media` specialist. From the principal's chat it "never returned," and the
coordinator reported it as "the same Bluesky API timeout we've been fighting."

Production audit-log forensics told a different story:

- **The Bluesky API was healthy** — ~860 `atproto-mcp` calls at 99.5% success
  (`get_user_connections` 78/78, `unfollow_user` 340/341). There was no API outage.
- **The real failure was a budget/envelope mismatch.** The `social-media` specialist is
  sized as a lightweight twice-daily heartbeat (`max_turns: 25`, ~180–240s delegate
  timeout, no bulk operations). The single `agent.error` in the window was
  `BUDGET_EXCEEDED / reason: maxTurns` with `consecutiveErrors: 0` — it ran out of turns
  mid-work, it did not hit an error.
- **The coordinator confabulated an external cause.** The delegate skill only reported
  "specialist didn't respond within timeout"; the coordinator pattern-matched that to a
  Bluesky API timeout and then re-delegated the agent **51 times over 5 hours** to grind
  through the work 25 turns at a time.
- **A tool gap doubled the cost.** `unfollow_user` needs a follow-record URI, but
  `get_user_connections` returns only the followee `did`. With no DID→URI lookup, the
  agent improvised: `follow_user(did)` is idempotent and returns the existing record's
  URI (264/270 follow calls came back "User was already being followed"), which it then
  deleted. Every unfollow became **two** tool calls, roughly halving throughput per
  25-turn slice (~12 accounts/slice) and accelerating the budget exhaustion.
- **A leftover subtask never converges.** "Batch 2/13" is still `open` and gets re-poked
  by the `BacklogHeartbeat` every ~4h (confirmed 3×), each wake `last_run_outcome:
  completed` yet the task never closes — a futility loop now spread across days. The
  backstop prevents silent loss but, without resumption or reconciliation, turns one
  failure into a recurring one.

None of this is Bluesky-specific. It is a general gap in how the platform runs **work
that exceeds a single executor invocation** — and it will recur with other specialists
(a research-analyst told to read 40 documents, a contacts agent told to dedupe 500
records) and other goals.

## The six gaps

1. **Executor budgets are sized for the agent's default beat, not the delegated task.**
   The budget is a property of the agent; the work is a property of the task. Nothing
   reconciles them.
2. **There is no first-class "long job with checkpoints."** The only state that survived
   between the 51 delegations was a cursor the agent *manually* stuffed into
   config-store. Resumption is not a platform property.
3. **The failure reason does not reach the planner, so it confabulates.**
   `BUDGET_EXCEEDED` was flattened to "didn't respond," became "API timeout," and drove
   identical blind retries.
4. **Nothing right-sizes the work to the executor's real throughput.** "13 batches of
   100" was fiction; the agent cleared ~12 accounts per slice.
5. **Partial progress is not treated as success.** Hitting the budget should be a *pause*,
   not a *failure*.
6. **No completion ledger / orphan reconciliation.** A `done` parent leaves open children
   to be re-poked forever.

## Design overview — one resumable-task umbrella

The spine is a single model: **a goal becomes a `plan`, progress is tracked as "X of Y
steps done," and resumption advances the frontier until done.** Both quantitative sweeps
("process 1,300 follows") and qualitative goals ("design the 2026 sales kickoff with the
6 execs") are the same thing at the right altitude — a planner breaking a goal into
trackable units.

### Two principles that shaped the model

**(A) No project foresight in agent authors.** You write a *generic* `social-media`
agent — bluesky skills plus guidance on using them — and never anticipate a follow-audit,
because the space of projects is unbounded and unpredictable. The structure of a project
(paginate, judge, unfollow, email flagged) is decided **at runtime by the LLM** when it
picks up the task, not at authoring time. Therefore resumability cannot rely on
author-declared iteration; it must be driven by the runtime LLM through **generic harness
primitives**, steered by platform-level guidance, and guaranteed by a deterministic
safety-net.

**(B) Materialization is the only reason to distinguish "kinds" of work.** A planned step
becomes a real child task row (so it can be dispatched, blocked, and scheduled
independently) — right for the ~10 heterogeneous steps of a sales kickoff. You emphatically
do *not* want 1,300 child rows for the follows. So a high-count homogeneous step is
represented as a **single leaf that loops over a collection with a cursor** — no row per
item. The cursor is therefore a *leaf representation the planner chooses for efficiency*,
**not** a parallel mode anyone reasons about. Under the hood a step is one of:

- **planned step** → materializes as a child task; its progress is its children's "X of Y"
- **iterate leaf** → a leaf that loops over a collection with a cursor + accumulator;
  reports its own internal "X of Y"; no rows
- **atomic leaf** → done in one invocation

All three report "X of Y" upward. One model, one progress notion, one resume loop.

### The two generic primitives

Resumability is runtime-LLM-driven through two harness primitives that **any** agent can
invoke — neither requires project-specific authoring:

- **`checkpoint(progress)`** — a generic tool available to every agent on a resumable
  task. `progress` is opaque and LLM-authored: a cursor/position, a done/total estimate,
  the accumulator (e.g. the flagged-for-review list) or a pointer to where it is stored,
  and a one-line "what's next." The *LLM* decides what the cursor means for *this*
  project; the *platform* provides the durable slot and persists it.
- **`plan(goal)`** — a generic tool that decomposes a goal into child steps with
  dependencies and assigned executors. **Progressive and lazy** (a step decomposes
  further only when picked up — no demand to plan the whole tree up front) and
  **adaptive** (re-plannable as children complete). Rides primitives the platform already
  has: `parent_task_id` (the tree), `blocked_by_task_id` (dependencies),
  `waiting_on_contact_id` (a step waiting on a human — which the `BacklogHeartbeat`
  already treats specially).

`checkpoint` and `plan` are symmetric: both are generic primitives the runtime LLM uses,
both demand zero project foresight from the agent author. The agent is always
generic-skills-plus-guidance; the project's shape is always the runtime LLM's call.

This matches what already happened in prod: the Bluesky agent was *already* hand-stashing
a cursor in config-store with nobody telling it to. The LLM does this naturally when it
has somewhere to put it. We are formalizing the "somewhere" (`checkpoint`), the "do it
periodically" (platform guidance + budget nudge, below), and the "resume reads it"
(harness).

### Worked example — "design the 2026 sales kickoff with the 6 execs"

On first pickup the LLM judges the goal complex and calls `plan`, emitting children:
*gather input from each of 6 execs* (six `waiting_on_contact` human-input steps),
*synthesize themes* (`blocked_by` the six gathers), *draft agenda*, *design sessions*,
*review with execs*, and a final *assemble the kickoff plan* step that is `blocked_by` the
rest. Each child runs through the same machinery: a countable child uses an iterate leaf;
an atomic child just completes; a still-complex child (*design sessions*) calls `plan`
again when picked up. The six human-waits sit on `waiting_on_contact`; the heartbeat
nudges them. When the subtree resolves, the final step's output is the parent's
deliverable. **Synthesis is not special machinery — it is just the last planned step**;
the harness only needs to mark which step's output is the parent's result (or default to
rolling up children's summaries).

## Runtime behavior

### The resumable-execution contract

An executor invocation returns one of three outcomes:

| Outcome | Meaning | Effect |
|---|---|---|
| `done` | Work complete | Task → `done`; carries the final summary/deliverable |
| `paused` | Real progress made, more remains | Task stays `in_progress`; checkpoint persisted; continuation scheduled. **This is a success at the delegation layer, not a timeout.** |
| `failed` | Genuine error | Carries a structured `reason` (`budget_max_turns`, `tool_error`, `api_error`, `blocked`) and `retryable: bool`, propagated honestly upward |

**`paused` reuses the existing `in_progress` status** — no new task status, no schema
churn. The resumable state lives in the task's existing `progress` JSONB under a
`resumable` block (cursor, done/total, accumulator-or-pointer, last-slice units). The
accumulator must be bounded (cap + spill to storage) so a long job cannot bloat the JSONB.

### Checkpointing — a harness guarantee, not an author convention

Two layers, because LLMs are unreliable at self-stopping:

- **Cooperative.** The platform injects generic resumable-task guidance (at the
  task-execution layer, *not* in the agent's authored prompt): *"This is a long task.
  Checkpoint your progress periodically and before you run low on budget. On resume, your
  last checkpoint will be handed back to you — continue from it."* Plus a **threshold
  budget nudge**: when remaining turns/cost drop below a margin (e.g. 15%), the harness
  appends a one-time "checkpoint and pause now" signal.
- **Safety-net (the real guarantee).** If the runtime hits the hard budget wall anyway on
  a resumable task, it **converts the budget-hit into `paused`** from the last persisted
  checkpoint, instead of emitting today's `BUDGET_EXCEEDED` error. If no checkpoint was
  ever written, that is an honest `failed` (nothing to resume).

Because correctness rests on the safety-net, the cooperative nudge is a latency
optimization, not a dependency.

### Budget-nudge placement and prompt-cache safety (provider-portable)

The budget nudge is volatile per-turn content, so placement matters for prompt caching.
All providers Curia routes through OpenRouter use **prefix caching** (Anthropic via
`cache_control` breakpoints; OpenAI / DeepSeek / Grok automatically — the `social-media`
"standard" tier routes to `deepseek/deepseek-v4-pro`, which auto-caches prefixes). The
universal rule: **volatile data goes at the tail of `messages`, never in the cached
prefix** (`tools` / `system`). Appending a tail message invalidates only the
messages-cache tier, never the expensive tools+system tier.

- Where the provider supports a non-spoofable mid-conversation operator channel (e.g.
  Opus 4.8's `role:"system"` mid-`messages`, beta `mid-conversation-system-2026-04-07`),
  use it.
- Otherwise append the nudge to the tail of the last turn in whatever role the routed
  model honors (a late `system` message is not honored consistently across OpenAI-compatible
  models).
- Either way, resumption is guaranteed by the safety-net, **not** the nudge — so model
  variance in honoring tail/system messages does not gate correctness.

*Phase-1 confirmation:* check which routed models support prompt caching at all, and which
honor mid-array system messages. The design does not depend on the answer.

### The resume loop

A `paused` task schedules its **own near-term continuation** wake (seconds, via
`scheduled_jobs`) rather than waiting for the ~4h `BacklogHeartbeat` — so an iterate leaf
loops promptly and a planned step advances its frontier as children finish. The heartbeat
remains the **backstop** (a lost continuation or a crashed process is re-surfaced on the
hourly tick). For a planned step, each wake dispatches newly-unblocked children and
re-evaluates the plan; the step completes when all children resolve and its deliverable
step is done.

### The circuit-breaker — progress, not error count

This is the direct fix for the futility loop. Every continuation must show **forward
progress** (cursor advanced or done-count increased). A continuation that returns `paused`
with no progress increments a **stall counter**; after K stalls the task is marked
`failed` / needs-attention and escalated. Plus hard ceilings per resumable task (max
iterations / wallclock / cost). Today's budget counts *errors*
(`maxConsecutiveErrors`), so a loop that returns `success` with no progress never trips —
keying the breaker on **progress** is what stops both the 51-delegation grind and the
"re-poked forever, outcome=completed" Batch-2 loop.

### Honest status propagation

The structured outcome flows to the coordinator as data, replacing "specialist didn't
respond":

- `paused` → progress; do not retry; optionally surface "still working, X of Y."
- `failed{retryable:false}` → honor it; escalate honestly; **no blind re-delegation.**
- `failed{retryable:true}` → bounded retry.

This ends the confabulation: the coordinator now receives a real `failed` reason and
reports the truth.

> **Reason-enum spelling superseded by [spec 20 §1](../specs/20-resumable-tasks-and-projects.md).**
> This memo's `budget_max_turns` is the executor-contract token (`ExecutorFailureReason`,
> `src/agents/resumable-task.ts`). The reason the coordinator actually sees on the
> `agent.response` event is `AgentResponseFailureReason` (`src/bus/events.ts`):
> `maxTurns` for turn-budget exhaustion, plus `maxConsecutiveErrors`, `tool_error`,
> `api_error`, `blocked`. See spec 20 §1 for the authoritative enums and their mapping.

### Completion & reconciliation

When a goal completes, is cancelled, or is superseded, its open children are **reconciled**
(cancelled with a reason), not left for the heartbeat to re-poke — the direct fix for the
orphaned Batch 2. A parent whose plan is fully done auto-completes and surfaces its
deliverable step's output. Stall / ceiling breaches surface to the principal through the
existing backlog-surfacing path rather than looping silently.

## Phasing

- **Phase 0 — three cheap, independent wins** (each useful alone; they are the foundation
  the rest needs):
  1. Propagate the real failure reason from the runtime to the coordinator (stop
     confabulation).
  2. Honor `retryable:false` at the delegation layer (stop blind re-delegation).
  3. Add a DID→follow-record-URI lookup to the Bluesky integration (or let `unfollow_user`
     accept a `did`/`handle` and resolve internally) — kills the 2× cost.
- **Phase 1 — resumable iterate leaves**: the `paused`-as-success contract, the generic
  `checkpoint` primitive + platform resumable-task guidance, framework-owned durable
  checkpoint persistence, self-continuation scheduling, and the progress-based
  circuit-breaker. *This alone closes the Bluesky class of failure.*
- **Phase 2 — the `plan` primitive**: progressive/adaptive decomposition into child tasks,
  frontier advancement, completion reconciliation, and the deliverable/synthesis step.
  *This makes the sales-kickoff class of goal work.*
- **Phase 3 — fast-follows**: adaptive re-planning depth, throughput-based right-sizing,
  richer escalation UX.

## Non-goals / explicitly rejected

- **A separate "project runner" subsystem.** Rejected in favor of reusing `tasks` +
  `scheduled_jobs` + the heartbeat. Standing up a parallel orchestration subsystem that
  overlaps the scheduler is more infrastructure than the problem warrants.
- **Author-declared iteration (a per-unit handler supplied by the agent author).**
  Rejected — it assumes project foresight that cannot exist (principle A).
- **Coordinator-prompt-only resumption** (the LLM coordinator drives the whole loop).
  Rejected — it puts the loop in the exact layer that confabulated and blind-retried.
- **A new `paused` task status** and **special synthesis machinery.** Both rejected as
  unnecessary — reuse `in_progress`; synthesis is just the last planned step.

## Open questions for implementation

- Exact API shape of `checkpoint` (tool vs. skill) and how the harness re-injects the last
  checkpoint on resume.
- Continuation cadence and the ceiling defaults (max iterations / wallclock / cost) per
  resumable task, and how they compose with the autonomy engine and existing scheduler
  timeouts.
- Accumulator bounding policy (cap size, spill target) and whether large accumulators reuse
  an existing storage surface or need a new one.
- Whether `plan` writes child rows directly or proposes a plan the coordinator commits.

## Verification (when built)

- Re-run a small follow audit (e.g. 25 follows) end-to-end against prod and confirm via
  `docker logs curia-curia-1` + the `audit_log` trail that it completes within budget across
  resumed slices, unfollows the obvious ones, emails the flagged set, and leaves no orphaned
  `open` subtasks.
- Inject an artificial stall (a continuation that makes no progress) and confirm the
  circuit-breaker escalates rather than looping.
- Confirm a `done` parent reconciles (cancels) its open children.
