# Woken & derived task authorization (#1060)

Investigation issue: #1060. Implementation: #1125 (step 1), #1126 (step 2), #1127 (step 3);
follow-up: #1153 (`wake_at` lineage).

## Problem

`SchedulerService.enqueueTaskWake()` inserts its `scheduled_jobs` row **without an
`originator`** ([`scheduler-service.ts:988`](../../src/scheduler/scheduler-service.ts)),
so every heartbeat-woken task fires with `metadata: undefined`
([`scheduler.ts:420`](../../src/scheduler/scheduler.ts)) and no task provenance. Any
elevated skill invoked from a woken task is then blocked, and the autonomy-gate
principal-bypass is lost — regardless of how the originating task was created.

This is two problems stacked, and only the first is the one-liner:

1. **Data-model gap.** `TaskOriginator` (`{contactId, systemRole, channel, initiatedAt,
   tier}`) is stamped on the `agent.task` *event* and persisted durably on
   `scheduled_jobs`, `bullpen_threads`, and `secret_capture_tokens` — but **not** on the
   `tasks` table (migration 049 promoted `agent_tasks`→`tasks` with no originator column).
   `BacklogHeartbeat` selects candidate *tasks* and mints a *fresh* wake `scheduled_jobs`
   row; there is no prior job to copy an originator from, and the dedup review task
   (filed as a side-effect of a cron run) never had one. So the lineage has to live on
   the `tasks` row for the candidate query to return it.

2. **Authorization semantics.** What authorization *should* a woken/derived task carry?
   Naive inheritance is a privilege-escalation-across-task-boundaries hazard; zero
   inheritance silently breaks legitimate deferred work. Neither is acceptable, so a
   deliberate model is required.

### Why the obvious fixes are wrong

- **Thread the original originator through the wake unchanged.** Re-opens broad
  authorization: a woken/derived context would ride borrowed principal/system standing,
  and an agent-invented follow-up task would inherit rights it was never granted.
- **Lower `contact-merge` to non-elevated to "fix" the dedup case.** De-elevating a
  genuine control to paper over a scheduler gap. (We *do* move `contact-merge` to the
  autonomy-governed world below — but as a deliberate reclassification, not a downgrade
  of the control.)

## Decision

### 1. Separate **lineage** (audit) from **standing** (authorization)

- **Lineage** — the chain's original `TaskOriginator`, stamped on the `tasks` row at
  creation, immutable. Preserved across wakes *and* child-task creation. It is pure
  audit, and the **ceiling** for what may be inherited. It confers nothing on its own.
- **Standing** — what *this* execution context may do. Computed at skill-invocation
  time; does **not** inherit by default.

### 2. The autonomy score **downgrades** standing, never upgrades it

A woken/derived execution's **effective standing** is a function of
`(lineage, live autonomy score, execution context)`. The score can only ever *reduce*
the lineage's standing for non-live execution — it can never grant standing the lineage
didn't have. An agent-originated chain can never become principal, at any score.

This is the safe form of originator-threading. Inheriting standing is dangerous only
when trust is low; gating it on the autonomy score maps the hazard exactly onto "the CEO
has signalled how freely Curia may act autonomously."

**Effective standing is computed from the *live* score at invocation time**, not cached
at wake time. If the CEO lowers the score, in-flight woken tasks lose inherited standing
on their very next action — the "pull back → caution everywhere" behaviour.

### 3. The bypass ladder

Thresholds live in autonomy config (tunable; defaults below), expressed as raw scores —
**not** coupled to the autonomy engine's band *names*, whose granularity we don't want to
import.

| Live score | Posture | Same-task heartbeat wake | Agent-spawned child task |
|---|---|---|---|
| `< 70` | A | downgrade → agent (propose-only) | downgrade → agent |
| `70–89` | B | keep lineage standing | downgrade → agent |
| `≥ 90` | D | keep lineage standing | keep lineage standing |

B's floor cannot sensibly drop below 60: "keep principal standing on a wake" activates
the principal-bypass, and letting that fire under restricted mode (`<60`) would let a
woken task bypass the very block restricted mode exists to enforce.

A pre-authorized **specific** deferred action ("email X tomorrow at 10am") belongs on the
**scheduler** path, which already preserves the principal originator at fire time
([`scheduler.ts` `fireJob`](../../src/scheduler/scheduler.ts)) because the principal specified
the action *and* the time. Open-ended backlog that the *heartbeat* nudges is subject to
the ladder. This resolves issue #1060 case (b) without special-casing.

### 3a. How the runtime distinguishes the three job types (implementation, #1125)

The "heartbeat = laddered / scheduler = preserve principal" split above is realized by a
`standing` envelope on the wake job, **not** by inspecting the originator:

- `enqueueTaskWake` (the BacklogHeartbeat path) writes `task_payload.standing = { derived }`
  onto the `scheduled_jobs` row, alongside the `originator` column.
- `Scheduler.fireJob` stamps a `wakeContext` marker on the fired `agent.task` metadata
  **only when that envelope is present**; `computeEffectiveTaskMetadata` applies the ladder
  **only when** `wakeContext` is present.

That cleanly separates the three cases:

| Job kind | originator | `standing` envelope | At fire time |
|---|---|---|---|
| BacklogHeartbeat wake | yes | yes | laddered (may downgrade) |
| `scheduler-create` job | yes | no | keeps originator, no ladder (pre-authorized) |
| task `wake_at` self-defer | see §3b | no | keeps originator, no ladder (pre-authorized) |

The marker is keyed on the envelope, not on `job.originator`, so a heartbeat wake of a
pre-065 / unstamped task (null originator) still gets a `wakeContext` — the ladder is a
no-op on null lineage, but the path stays uniform. **"Derived" is structural:**
`source = 'agent' OR parent_task_id IS NOT NULL`, computed in `selectHeartbeatCandidates`.

### 3b. Known gap: task `wake_at` self-deferral drops lineage

A task that defers itself via its own `wake_at` column currently mints a one-shot wake job
with **no** originator and no `standing` envelope (see the `@TODO(#1125/#1127)` in
[`task-repo.ts`](../../src/db/task-repo.ts)), so it fires with `metadata: undefined` and
floors to agent / no-bypass. But a `wake_at` time is *pre-chosen*, so it should be treated
like `scheduler-create` — **keep** the originator at fire time, **not** laddered, **not**
floored. As shipped it under-authorizes a principal-lineage task that self-defers. Out of
#1125's scope (heartbeat path only); tracked as #1153.

### 4. `elevated` means a **live** principal turn

`sensitivity: elevated` is redefined to require a **live principal turn** — the current
turn originated from a fresh principal inbound. It is never satisfiable by system, agent,
or any inherited/woken standing (even principal *lineage* on a wake). "Live principal" is
stamped only when the dispatcher processes a real principal message; wakes, derivations,
and scheduler fires never carry it.

This is enforced **only at the execution-layer gate**
([`execution.ts:591`](../../src/skills/execution.ts)). All handler-level
`isPrincipalOriginated` re-checks are abolished — they froze the *old* "principal only"
definition, drifted out of sync when the gate widened to "principal or system" in
`3bd3d224`, and are exactly the whack-a-mole hazard a single definition removes.

> **Status after #1125:** the handler re-checks are *not yet* abolished — #1126 does that.
> In the interim #1125 made them safe rather than removing them: the execution layer forwards
> **effective** (post-ladder) standing to handlers (`ctx.taskMetadata = effectiveTaskMetadata`,
> `execution.ts:969`), so a re-check on a woken principal-lineage task now sees the downgraded
> standing instead of raw lineage. These re-checks are therefore load-bearing until #1126
> replaces them — confirm the gate (or an `action_risk` + autonomy gate) covers each one
> before deleting it. See the caveat posted on #1126.

"Live principal" closes the **self-approval hole** with zero per-skill exceptions: a
woken principal-*lineage* task can never approve its own pending action, because lineage
is not a live turn.

Note: the principal-bypass of the autonomy *score* gate
([`execution.ts:669`](../../src/skills/execution.ts)) and the `elevated` gate use two
different notions of "principal" — and they should. Exercising authority (approve an
action) needs the human *now*; acting *within* work the CEO authorized (a normal skill)
can reasonably be inherited at high trust via the ladder.

### 5. Consequential autonomous actions are governed by the autonomy engine, not standing

The current `elevated` label does triple duty across 19 skills. It is decomposed:

- **Stay `elevated` (live-principal authority primitive):** `approve-action`,
  `deny-action`, `dismiss-action`, `set-autonomy`, `approve-grant-recommendation`,
  `decline-grant-recommendation`. "The CEO is exercising authority."
- **→ `normal` + `action_risk` (autonomy-governed; inherits the ADR-018 approval flow
  for free):** `contact-merge`, `contact-update`, `contact-rename`,
  `behavioral-preferences-update`, `executive-profile-update`, `scheduler-create`,
  `scheduler-cancel`.
- **→ `normal` + `action_risk: none` + `allowed_callers`:** `list-pending-actions` — a
  sensitive *read*. The right control is *which agent may call it*, not *who originated
  the task*; the 8am digest job runs as the coordinator. This is the **sole** reason
  `system` was ever allowed through the gate (`3bd3d224`), so handling it this way is
  what makes the live-principal definition safe.
- **Decide explicitly (issue #1126):** `contact-grant-permission`,
  `contact-revoke-permission`, `contact-set-tier`, `contact-set-role` (these alter
  authorization itself — authority-primitive vs. high-risk mutation?); `web-browser` (an
  egress/injection gate, not authority or a mutation — likely `allowed_callers` +
  `action_risk`).

After this, **`system` standing loses all gate power** and becomes pure audit lineage +
the "skip the external-contact tier gate" signal in
[`getInitiatingTier`](../../src/contacts/principal.ts). The ladder then governs exactly
one thing: whether a woken/derived **normal**-skill execution inherits the
principal-bypass.

## Target behaviour by case (issue #1060 acceptance criterion)

- **(a) system-scheduled → filed task → woken** (the dedup case). The review task's
  lineage is `system` (inherited from the cron, never upgraded). As a *child* task it
  downgrades to agent at postures A and B; only at posture D (`≥90`) does it retain
  system standing. Either way, `contact-merge` is no longer `elevated` — it is
  autonomy-governed, so a heartbeat-woken review task that lacks the score (or the
  principal-bypass) is **blocked → surfaces an ADR-018 approval request → CEO confirms →
  the live principal turn executes the merge.** Surface-and-confirm.
- **(b) principal-originated → deferred → woken.** A *specific* pre-authorized action is
  a scheduled job (keeps principal standing at fire time — unchanged, already works).
  Open-ended deferred work woken by the heartbeat retains the principal-bypass only per
  the ladder (posture B/D), and never the `elevated` authority primitives (those need a
  live turn).
- **(c) agent-originated → deferred → woken.** Agent standing is the floor; a wake never
  raises it. Propose-only for anything gated.

### `contact-merge` via a heartbeat-woken dedup review task

**Surface-and-confirm; never auto-execute by default.** `contact-merge` moves to
`normal` + `action_risk` (issue #1126), so a woken review task that cannot clear the
autonomy gate files an ADR-018 approval request and the CEO's reply (a live principal
turn) performs the merge. Whether a sufficiently high autonomy score should let it
auto-execute — vs. always confirm regardless of score — is the explicit decision made
when `contact-merge`'s `action_risk` is set in #1126.

## Relationship to existing ADRs

- **ADR-011 (score-based autonomy).** The bypass ladder is an *extension* of ADR-011's
  thesis — the score now also governs how much standing a woken/derived task inherits.
- **ADR-017 (CEO-authorized action).** "Principal authority" is sharpened to *live*
  principal, and the gate becomes the single enforcement point (no handler re-checks).
- **ADR-018 (Curia-initiated approval requests).** Consequential actions that leave the
  standing-gated world become autonomy-governed and inherit the ADR-018
  block→request→approve→re-execute flow with no per-skill work.

This is a clarification/extension of those decisions, not a competing one — hence a
design note plus targeted ADR/spec edits, **not** a new ADR.

## Implementation & doc-sync

Three issues, completed in order:

- **#1125 (step 1, foundation):** persist `TaskOriginator` on `tasks`; thread it through
  `enqueueTaskWake`; the score-keyed effective-standing computation + ladder, wired into
  both the principal-bypass and the `elevated` gate's *input* (gate requirement stays
  principal-or-system here). Prerequisite for the other two.
- **#1126 (step 2, depends on #1125):** redefine `elevated` = live principal; audit &
  reclassify all 19 elevated skills; abolish handler re-checks; resolve the Bucket-D
  borderlines. Gate change + reclassification land atomically.
- **#1127 (step 3, depends on #1125; parallel to #1126):** stamp `TaskOriginator` on
  console-created tasks/scheduled jobs (a principal surface — must not default to
  propose-only).
- **#1153 (follow-up, depends on #1125):** thread `TaskOriginator` onto task `wake_at`
  self-deferral wake jobs so a pre-chosen deferral keeps its originator at fire time
  (no ladder) instead of flooring to agent — see §3b.

Doc-sync lands with the implementation PRs (specs describe shipped behaviour): ADR-011,
ADR-017 (+ ADR-018 cross-ref), spec 03 (Skills & Execution), spec 14 (Autonomy Engine),
spec 19 (Tasks & Backlog).
