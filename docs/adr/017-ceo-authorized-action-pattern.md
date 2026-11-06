# ADR-017: CEO-authorized action pattern

Date: 2026-05-02
Status: Accepted

## Context

Some skills represent actions the CEO has explicitly directed Curia to take in the
moment — not autonomous decisions, but direct CEO instructions. The prototypical
example is `send-draft`: the CEO says "send that draft," and Curia should honour
it regardless of the current autonomy score.

This creates a tension with the autonomy gate system. The autonomy score governs
how freely Curia acts *autonomously*. But a CEO-directed action is the opposite
of autonomous: the human is explicitly in the loop at the moment of invocation.
Blocking a CEO instruction because the autonomy score is 65 is the wrong outcome.

Three approaches were considered:

**A. `action_risk: "medium"` with no bypass.** The execution layer blocks the
skill at score < 70. To approve a send, the CEO must first raise the autonomy
score, then the skill runs, then optionally lower it again. Safe but creates
friction specifically in the scenario where the CEO is trying to override a
cautious autonomy posture.

**B. Dedicated gateway method per approved action type.**
`sendApprovedEmailDraft()`, `sendApprovedSignalMessage()`, etc. Each method
encapsulates the approved-send pipeline with the autonomy gate bypassed. Sets a
precedent that every CEO-approved action type needs its own gateway method — not
sustainable as the action surface grows.

**C. `action_risk: "none"` + task-origin check + `humanApproved: true` flag.**
The skill is not treated as an autonomous action by the execution layer. The real
enforcement is a hard check in the handler that verifies the task originated from
a CEO-authenticated message. The gateway's autonomy gate is bypassed via a narrow
flag, but all other safety checks (content filter, blocked-contact) run normally.

## Decision

**Option C.** CEO-authorized skills use `action_risk: "none"` and enforce CEO
authorization through a task-origin check in the handler, not through the autonomy
score system.

**Pattern components:**

1. **`action_risk: "none"`** in the skill manifest. The execution layer's autonomy
   gate is designed for autonomous actions. CEO-directed skills are not autonomous;
   they should not be gated by a score the CEO set to control *Curia's* judgment.

2. **Task-origin check in the handler.** The handler verifies
   `ctx.taskMetadata?.ceoInitiated === true` as the first step. This is a hard
   rejection: if the flag is absent, the skill returns an error immediately — no
   Nylas calls, no sends, nothing. The LLM cannot set `ctx.taskMetadata`; this
   flag is stamped by the dispatch layer in TypeScript code.

3. **`ceoInitiated` stamping in the dispatch layer.** When an inbound message's
   sender matches the CEO's known channel identities (from the executive profile),
   the dispatch layer stamps `ceoInitiated: true`, `senderId`, and `channelId`
   into the task metadata. Observation-mode tasks (triggered by external emails
   monitored on the CEO's behalf) explicitly do not receive this flag, preventing
   prompt injection from external sources from triggering approved actions.

4. **`humanApproved: true` option on `OutboundGateway.send()`.** When set, the
   gateway's autonomy gate (Step 0) is skipped. All other checks run unchanged:
   blocked-contact check, content filter, channel dispatch. This is one general
   option on the existing method — not a new method per action type.

5. **`human.decision` audit event.** The handler publishes a `human.decision` bus
   event after a successful approved send, recording the decision, the approver's
   identity, the channel, and timing. This creates a durable audit trail for every
   CEO-authorized bypass.

**Why `action_risk: "none"` does not weaken safety:**

The only realistic failure mode is a bug in `ceoInitiated` stamping that
incorrectly sets the flag. Raising `action_risk` to `"medium"` would not protect
against this: if `ceoInitiated` is incorrectly set, the task-origin check passes
regardless of `action_risk`; if it is correctly absent, the task-origin check
rejects regardless of `action_risk`. The `action_risk` level is not the deciding
factor in either outcome. The defence against incorrect `ceoInitiated` stamping is
to make that stamping logic reliable — not to add a backstop that would also block
legitimate CEO-directed sends.

## Consequences

**Easier:**
- CEO-directed skills work at any autonomy score without the CEO needing to
  temporarily raise the score to unlock a specific action.
- The pattern is general: any future CEO-authorized skill (`send-approved-signal`,
  a CEO-override calendar write, etc.) follows the same recipe without new gateway
  methods.
- The audit trail is explicit: every CEO-authorized bypass produces a
  `human.decision` event that is separately queryable from autonomous actions.

**Harder / accepted trade-offs:**
- The `ceoInitiated` stamping logic must be correct. If it fires too broadly
  (e.g., stamps all tasks), CEO-authorized skills become reachable without genuine
  CEO approval. This logic should have its own unit tests.
  *(Note: "observation-mode tasks" was a concern at the time this ADR was written;
  observation mode was removed in v0.25.x as part of the CEO inbox redesign — the
  CEO's email is now a skill domain, not a channel.)*
- `action_risk: "none"` on a skill that sends email looks surprising in isolation.
  Implementers who encounter it without context may be tempted to raise it. This
  ADR is the explanation; the skill manifest description should also include a
  comment pointing here.
- This pattern applies only to skills where the CEO is verifiably in the loop at
  invocation time. It must not be used for skills that act autonomously based on
  inferred or cached intent — those should use the standard `action_risk` tiers
  and the Curia-initiated approval request flow (see ADR-018).

## Update (#1126): "principal authority" sharpened to a *live* principal turn

Two refinements land here (now documented in `docs/specs/03-tools-and-execution.md` — the `elevated` = live-principal-turn gate — and `docs/specs/14-autonomy-engine.md` — effective standing):

1. **The `legacy ceoInitiated` flag is gone.** Origination is now carried by `taskMetadata.originator` (a `TaskOriginator` with a `systemRole`), stamped exclusively by the dispatch layer from the contact resolver — never settable by the LLM or a channel. The "task-origin check" in this ADR is realized through that field.

2. **"Principal authority" is now *live* principal, and the `elevated` gate is the single enforcement point.** The `sensitivity: 'elevated'` mechanism — distinct from this ADR's `action_risk: 'none'` + handler-origin Option C — is redefined to require a **live principal turn**: the current turn must trace to a fresh principal inbound, never to system, agent, or *inherited/woken* principal **lineage**. It is enforced solely at the execution-layer gate (`isLivePrincipalTurn`); the handler-level origination re-checks that previously duplicated it on every elevated skill were **abolished** — they had frozen the old "principal-only", then "principal-or-system", definitions and drifted out of sync. This closes the self-approval hole with zero per-skill exceptions.

   **The live signal is a distinct field, and it flows through synchronous delegation.** `liveTurn` is a top-level field on the `agent.task` payload (threaded to `InvokeOptions.liveTurn`), deliberately **not** a key in the task-metadata bag — because the persistence skills (`scheduler-create`, `task-create`, `bullpen`, the wake path) forward `metadata`/`originator` by name, and keeping the live signal out of that bag makes "never persisted" a *structural* guarantee rather than a per-skill discipline. The dispatcher *computes* it (never copies it from inbound input, so it cannot be forged), and the `delegate` skill forwards it across a **synchronous** delegation. The mental model is therefore "the CEO is live" = **the whole synchronous call tree**: a specialist delegated-to inside the CEO's turn inherits it (which is why the authorization-altering contact skills, pinned to the delegated contacts specialist, and `system-secret-capture-request`, used by the delegated setup-wizard, can be `elevated`), but the moment work crosses an async/persistence boundary (a scheduled job, a `wake_at`, a persisted bullpen thread) the signal is structurally gone.

This ADR's **Option C pattern still stands** for the narrow class it was written for: `send-draft` (and `calendar-list-events`) remain `action_risk: 'none'` + a handler-level origination check, *because* `action_risk: 'none'` means the autonomy gate cannot govern them — so the handler check is load-bearing and is deliberately retained, not abolished. The "abolish handler re-checks" rule of #1126 applies to the `elevated` mechanism, which the live-principal gate fully covers; it does not strip the Option C handler check from skills the gate does not cover. The distinction between *lineage* (inheritable at high trust for `normal` skills, via the autonomy ladder) and a *live turn* (required for `elevated`) is the crux — see ADR-011's update and ADR-018.

## Amendment (#2495, 2026-11-06): a live voice call is a live principal turn; its async continuation is not

**Context.** The #1126 boundary had one gap. On a voice call the slim voice brain hands work it can't do to the coordinator through `async-offramp`. That hand-off is an async boundary, so it dropped `liveTurn`, even in `mode: "now"` while the principal was still on the line waiting for the answer. Every elevated action the principal directed on a call failed. In prod, two attempts to block suspected-spam contacts with `contact-set-tier` were refused with "requires a live principal turn", while the same tool succeeded 5 of 5 times when delegated from a live email or console turn. A principal speaking on a call is the case #1126 meant to allow, not the self-approval it meant to stop.

**Decision.** A connected call is a live principal turn for the actions the principal directs during it. The async continuation of the call is not.

- **Live-turn grant.** A `mode: "now"` hand-off from the principal carries `liveTurn` together with a **live-turn grant** id (`src/autonomy/live-turn-grants.ts`). `liveTurn` counts only while the grant is active. The off-ramp revokes the grant when its wait on the call returns, whether with a reply, a question, the time limit or the caller speaking. The voice runtime revokes every grant of a session when the call ends. The grant's TTL is the wait itself, so it lapses even if neither revoke runs. The execution layer clears `liveTurn` at the top of `invoke()` once the grant has lapsed, so the elevated gate, the handler's `ctx.liveTurn` and `delegate`'s forward all see it as not live.
- **Never persisted, never inherited past the request.** Grants live in process memory only. The id is a distinct top-level `agent.task` field (`liveTurnGrantId`), like `liveTurn`, never a metadata key, so no persistence skill can sweep it into a row, and after a restart every id reads as lapsed. `delegate` forwards it with `liveTurn`, so the specialist serving the request is bound by the same grant. Wakes, scheduler fires, bullpen threads and the off-ramp's own forward task build their own `agent.task` without it. The `wakeContext` rejection in the elevated gate still holds even if a grant leaked onto a wake.
- **Confirmation, not a bare failure, once the call is no longer live.** A `mode: "after_call"` hand-off carries a grant id that was never active. Under a lapsed grant, an elevated call with principal lineage, outside a wake, files an approval request through the existing ADR-018 path instead of failing. The principal confirms it on any channel, and every approval path replays it with `humanApproved` inside the approving live turn so the replay passes the elevated gate: `approve-action` forwards `liveTurn`, a principal reaction now stamps a principal originator, and the console approval passes `liveTurn`. The outbound send judge's evidence reads a hand-off task's `liveTurn` through the same grant check. The advisory tells the agent the action needs confirmation and never that the capability is missing. `approve-action`, `deny-action` and `dismiss-action` are excluded, since approving an approval is circular.

**Consequences.** The off-ramp's coordinator, and the specialists it delegates to synchronously, can run elevated tools for at most the call's wait on the hand-off (60 seconds). Anything after that needs the principal's confirmation. A task that carries no grant id, such as a scheduled, woken or bullpen task, keeps the plain #1126 refusal. Grants are single-process state, in line with the in-memory verification tracker (ADR-050).
