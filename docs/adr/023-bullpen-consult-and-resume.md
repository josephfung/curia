# ADR-023: Async bullpen consult-and-resume convention

Date: 2026-06-25
Status: Accepted

## Context

Agents sometimes need specialist input mid-task before they can complete their
work — the most concrete example being `ceo-inbox` needing conflict-free,
held, timezone-labelled slots from the calendar specialist before it can draft
a scheduling reply. The question is how to structure that cross-agent
consultation without violating the platform's timing and security constraints.

Two constraints narrow the solution space:

1. **The bullpen is asynchronous by design.** `bullpen.post` fires an
   `agent.discuss` event fire-and-forget. This was a deliberate choice
   (ADR-002, issue #721): holding a skill execution turn open across an
   inter-agent round-trip risks hitting the skill timeout and then receiving
   the reply anyway, resulting in a duplicate task thread for the same inbound
   message.

2. **The only synchronous cross-agent primitive is `delegate`, and it is
   coordinator-locked.** `delegate` is restricted to
   `allowed_callers: ["coordinator"]` — specialists cannot call it directly.
   Unlocking it for peer-to-peer use would expand the security surface and
   still not solve the timeout problem.

Three approaches were considered:

**A. Synchronous cross-agent RPC / unlocking `delegate` for peers.** Would let
`ceo-inbox` block on the calendar specialist's response inline. Rejected: holds
an execution turn open, reintroduces the #721 timeout/duplicate-thread hazard,
and does not generalise to consulting multiple specialists in parallel (each
would block serially).

**B. A new bus event type** (e.g. `agent.consult` / `agent.consult_reply`).
Rejected: unnecessary — the existing `bullpen.post` and `bullpen.reply`
primitives already provide async message passing between agents. A new event
type would add framework complexity without changing the underlying timing model.

**C. An async tap / park / resume convention over the existing bullpen.**
Use what the platform already has: `bullpen.post` to tap the specialist, a
visible park marker on the originating work while waiting, and the specialist's
`bullpen.reply` as the resume signal. The dispatcher already creates a task for
thread participants when a bullpen reply arrives, so the originator is naturally
woken without any new infrastructure.

## Decision

Adopt option C: the **async bullpen consult-and-resume convention**.

The convention has three named phases:

1. **Tap.** The originating agent sends a structured `CONSULT REQUEST` to the
   specialist via `bullpen.post`. The request carries the full context the
   specialist needs plus a `source_message_id` that acts as a deduplication
   key — the originator includes it so the specialist's reply can carry it
   back, letting the originator locate and resume the original work item
   unambiguously even across retries.

2. **Park.** The originator marks the in-progress work as waiting. For
   `ceo-inbox` this means applying a `⏳ In Progress` label to the source
   email and marking it read — so the message stays visible in the inbox as
   outstanding but is not re-processed by the next poll. The exact park
   mechanic is per-agent; the invariant is that parked work must not be
   re-processed while waiting and must be identifiable when the resume signal
   arrives.

3. **Resume.** When the specialist calls `bullpen.reply` in the consultation
   thread, the dispatcher creates a new task for all thread participants
   (existing platform behaviour). The originating agent picks up the reply on
   its next turn, uses the `source_message_id` to locate the parked work,
   completes the task (for `ceo-inbox`: drafts the reply using the slot strings
   verbatim and archives the email), and clears the park marker.

No new event types, no new service, no new table. The convention is a usage
pattern over existing primitives.

## Consequences

**Easier:**

- Any agent that needs specialist input mid-task can adopt the tap/park/resume
  pattern without platform changes — wire `bullpen.post`, a park marker, and
  the `source_message_id` echo, and the resume falls out of normal bullpen
  mechanics.
- The `source_message_id` dedup key means a parked work item is safe to retry:
  if the originator is woken more than once (e.g. due to unrelated bullpen
  activity on the same thread), it checks whether the `source_message_id` in
  the reply matches before resuming, preventing duplicate drafts.
- The park marker provides operational visibility: a stale `⏳ In Progress`
  label is a signal that a consult did not complete. A future sweep can promote
  these to a `⚠️ Stuck` state (out of scope for this epic).
- The convention generalises to consulting multiple specialists: tap each via
  `bullpen.post`, accumulate replies keyed by `source_message_id`, resume once
  all expected replies have arrived (or after a timeout).

**Accepted trade-offs:**

- **Resume latency is seconds to minutes**, not synchronous. This is acceptable
  for `ceo-inbox` because scheduling reply drafts sit for human review before
  being sent anyway — the draft quality gained from a real consult outweighs
  the latency cost.
- **A stuck consult leaves a visible park marker.** If the specialist never
  replies (agent error, misconfigured bullpen routing), the originating work
  item stays parked indefinitely. The park marker makes this detectable — a
  stale-marker sweep is a noted follow-up, out of scope here.
- **The convention requires per-agent implementation.** There is no central
  framework support that enforces tap/park/resume correctly. Documentation (this
  ADR) and the `ceo-inbox` implementation serve as the canonical reference.
