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
| task `wake_at` self-defer | yes (#1153) | no | keeps originator, no ladder (pre-authorized) |

The marker is keyed on the envelope, not on `job.originator`, so a heartbeat wake of a
pre-065 / unstamped task (null originator) still gets a `wakeContext` — the ladder is a
no-op on null lineage, but the path stays uniform. **"Derived" is structural:**
`source = 'agent' OR parent_task_id IS NOT NULL`, computed in `selectHeartbeatCandidates`.

### 3b. Resolved (#1153): task `wake_at` self-deferral keeps lineage

**Status: shipped in #1153.** Previously a task that defers itself via its own `wake_at` column
minted a one-shot wake job with **no** originator and no `standing` envelope, so it fired with
`metadata: undefined` and floored to agent / no-bypass — under-authorizing a principal-lineage
self-deferral. A `wake_at` time is *pre-chosen*, so it is now treated like `scheduler-create`:
both `wake_at` mint sites in [`task-repo.ts`](../../src/db/task-repo.ts) (the `createTask` CTE and
the `updateTask` `_new_wake` arm) now persist the task's `originator` onto the wake job's
`scheduled_jobs` row, while still writing **no** `standing` envelope. `fireJob` therefore threads
the originator with no `wakeContext` — the bypass ladder never runs (the time was already decided)
and the originator is **kept** at fire time, not floored.

> **Interaction with #1126.** Fixing #1153 restores only the *autonomy* principal-bypass
> (for `normal` skills) — it carries no `standing` envelope, so it mints no `wakeContext` and
> is not subject to the ladder. A `wake_at` fire is still **not a live principal turn** (it
> carries no `liveTurn`), so `elevated` authority primitives stay blocked on wake. That is
> correct and intended: a pre-chosen self-deferral may resume CEO-authorized *work*, but must
> not *exercise authority* without the CEO present. #1153 must therefore thread the originator
> only — it must not attempt to thread `liveTurn`.

### 4. `elevated` means a **live** principal turn

`sensitivity: elevated` is redefined to require a **live principal turn** — the current
turn originated from a fresh principal inbound. It is never satisfiable by system, agent,
or any inherited/woken standing (even principal *lineage* on a wake).

**As shipped (#1126), the live signal is a distinct `liveTurn` boolean on the `agent.task`
payload — deliberately *not* a metadata-bag key.** Keeping it off the metadata bag is a
*structural* guarantee, not a discipline: no persistence skill (`scheduler-create`,
`task-create`, bullpen, `enqueueTaskWake`) can sweep it into a wakeable row, because those
copy named metadata fields by name and never the payload's `liveTurn`. The dispatcher
*computes* it (`originator.systemRole === 'principal'`) and never copies it from inbound
input, so it cannot be forged from a message. The gate predicate (`isLivePrincipalTurn`)
requires **both** `liveTurn === true` **and** a principal originator on the effective
metadata, so a stray flag without principal lineage still fails closed.

**It is forwarded across *synchronous* delegation.** The `delegate` skill threads
`ctx.liveTurn` onto the sub-task it publishes, so "the CEO is live" spans the whole
synchronous call tree: a delegated specialist (the contacts specialist, the setup-wizard)
acting *inside* the CEO's live turn inherits live-ness and may exercise an authority
primitive on the CEO's behalf. This is safe precisely because `delegate` is **ephemeral** —
an in-process bus request/response with no `tasks` row and no persistence — so the forwarded
signal evaporates at the async boundary and can never reach a wake. The **bullpen** path, by
contrast, carries lineage but deliberately **not** `liveTurn` (it is persisted/async), so a
bullpen specialist correctly cannot invoke elevated skills. Wakes, derivations, and scheduler
fires never carry it.

This is enforced **only at the execution-layer gate**
([`execution.ts`](../../src/skills/execution.ts), `isLivePrincipalTurn`). All handler-level
`isPrincipalOriginated` re-checks are abolished — they froze the *old* "principal only"
definition, drifted out of sync when the gate widened to "principal or system" in
`3bd3d224`, and are exactly the whack-a-mole hazard a single definition removes.

**Defence in depth (#1126).** Beyond the predicate above, the gate **rejects any task
carrying a `wakeContext` marker outright** — a wake is never a live turn, so even if
`liveTurn` somehow leaked onto a woken task the gate still fails closed. The dispatcher also
scrubs any inbound `liveTurn` (and the legacy `livePrincipal` alias) from the metadata bag.
The self-approval-hole closure is therefore pinned to the gate itself, not to the
dispatcher/scheduler behaving perfectly.

> **Shipped in #1126.** The interim #1125 state (handler re-checks kept but made safe by
> forwarding post-ladder *effective* standing to handlers) is superseded: the re-checks on
> the authority-primitive skills were removed and the gate is the single enforcement point.
> The two handler-level checks that remain (`send-draft`, `calendar-list-events`) are *not*
> elevated re-checks — they are the ADR-017 Option C `action_risk: none` + handler-origin
> pattern, a different mechanism intentionally left in place.

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
  `decline-grant-recommendation` — and, resolved in #1126, the authorization-altering
  contact skills `contact-set-tier`, `contact-set-role`, `contact-grant-permission`,
  `contact-revoke-permission`, plus `system-secret-capture-request`. "The CEO is exercising
  authority." (See the resolved Bucket-D note below for the rationale.)
- **→ `normal` + `action_risk` (autonomy-governed; inherits the ADR-018 approval flow
  for free):** `contact-merge`, `contact-update`, `contact-rename`,
  `behavioral-preferences-update`, `executive-profile-update`, `scheduler-create`,
  `scheduler-cancel`.
- **→ `normal` + `action_risk: none` + `allowed_callers`:** `list-pending-actions` — a
  sensitive *read*. The right control is *which agent may call it*, not *who originated
  the task*; the 8am digest job runs as the coordinator. This is the **sole** reason
  `system` was ever allowed through the gate (`3bd3d224`), so handling it this way is
  what makes the live-principal definition safe.
- **Resolved in #1126** (was "decide explicitly"):
  - `contact-grant-permission`, `contact-revoke-permission`, `contact-set-tier`,
    `contact-set-role` → **`elevated`**. They alter *who can do what*, so they are authority
    primitives, not mutations: minting or revoking authorization must require a live CEO and
    must never run autonomously on a schedule or job. Threading `liveTurn` through synchronous
    delegation (§4) is what makes this practical — a delegated contacts specialist can still
    run them *inside* the CEO's live turn.
  - `system-secret-capture-request` → **`elevated`** (`action_risk: none`,
    `allowed_callers: [setup-wizard]`). A secret-capture link is an authority artifact; gating
    it on a live turn ensures one can never be minted by a schedule or job. The setup-wizard
    only ever runs as a live, delegated turn, so this stays reachable in practice.
  - `web-browser` → **`normal`** + `action_risk: medium` + `allowed_callers: [coordinator]`.
    It is an egress/injection surface, not authority or a mutation — the right controls are
    which agent may call it plus the autonomy score, not the live-principal gate.
  - `contact-merge` → **`normal`** + `action_risk: medium` (surface-and-confirm below 70,
    auto at/above), per the dedup-case decision below.

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
- **#1126 (step 2, depends on #1125) — SHIPPED.** Redefined `elevated` = live principal
  turn, carried by a distinct off-bag `liveTurn` payload field and forwarded through
  *synchronous* delegation (§4); audited & reclassified all 19 elevated skills; abolished the
  handler re-checks (gate is the single enforcement point); resolved the Bucket-D borderlines
  (§5 — contact-auth skills + `system-secret-capture-request` to `elevated`, `web-browser` to
  `normal`). Added the `wakeContext` defence-in-depth at the gate. Gate change +
  reclassification landed atomically. ADR-011/017/018 + specs 03/14 updated.
- **#1127 (step 3, depends on #1125; parallel to #1126) — OPEN.** Stamp `TaskOriginator` on
  console-created tasks/scheduled jobs (a principal surface — must not default to
  propose-only). Scope is durable **lineage** only; whether a *live* console interaction sets
  the `liveTurn` signal is a dispatch-path question now that #1126 has shipped the mechanism —
  see the note on the issue.
- **#1153 (follow-up, depends on #1125) — SHIPPED.** Threaded `TaskOriginator` onto task
  `wake_at` self-deferral wake jobs (both the `createTask` CTE and the `updateTask` `_new_wake`
  arm) so a pre-chosen deferral keeps its originator at fire time (no ladder) instead of flooring
  to agent — see §3b.

Doc-sync lands with the implementation PRs (specs describe shipped behaviour): ADR-011,
ADR-017 (+ ADR-018 cross-ref), spec 03 (Skills & Execution), spec 14 (Autonomy Engine),
spec 19 (Tasks & Backlog).
