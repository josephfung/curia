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
  (e.g., stamps all tasks, or stamps observation-mode tasks), CEO-authorized skills
  become reachable without genuine CEO approval. This logic should have its own
  unit tests.
- `action_risk: "none"` on a skill that sends email looks surprising in isolation.
  Implementers who encounter it without context may be tempted to raise it. This
  ADR is the explanation; the skill manifest description should also include a
  comment pointing here.
- This pattern applies only to skills where the CEO is verifiably in the loop at
  invocation time. It must not be used for skills that act autonomously based on
  inferred or cached intent — those should use the standard `action_risk` tiers.
