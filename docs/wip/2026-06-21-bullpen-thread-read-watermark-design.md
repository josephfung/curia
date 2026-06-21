# Bullpen thread read-watermark (#1065)

## Problem

A Bullpen thread is re-actioned on a later coordinator wake, producing a duplicate
out-of-band action (the observed case: a duplicate Signal message to the principal).

The re-action comes from the **ambient injection** path, not the explicit dispatch
path:

- `BullpenDispatcher` creates one `agent.task` per participant when a *new message*
  is posted to a thread. This fires once per message — it is not the source of the bug.
- `getPendingThreadsForAgent` injects every open thread the agent participates in
  into the agent's context **on every task** (even unrelated ones), as ambient
  awareness. A thread is surfaced whenever `status='open'`, the agent is a
  participant, `last_message_at` is within the window, and the last message is not
  from the agent. When the agent fulfils a "please do X" request *out of band*
  (a send, a spreadsheet write, anything that leaves no in-thread reply), none of
  those conditions change, so the thread is injected again on the next wake and the
  LLM re-runs the action.

The first fix attempt closed the thread after an outbound *send* skill, gated on a
hardcoded `OUTBOUND_RELAY_SKILLS` set. That treats the symptom: it is send-specific,
and the allowlist silently misses any future action skill (calendar create, sheet
append, contact update, …) — the same duplicate-action bug, reintroduced with no
test failure.

## Fix: a per-agent read watermark

Track, per (thread, agent), the latest message the agent has already seen. Stop
re-surfacing a thread to that agent until a message *newer* than the watermark
arrives. This fixes the disease at the read side and is action-agnostic — it works
for every kind of out-of-band fulfilment, not just sends.

### Schema

`bullpen_thread_reads (thread_id UUID, agent_id TEXT, seen_through TIMESTAMPTZ,
updated_at TIMESTAMPTZ)`, PK `(thread_id, agent_id)`, FK to `bullpen_threads` with
`ON DELETE CASCADE`. (migration 060)

### Read path

`getPendingThreadsForAgent` gains a `LEFT JOIN bullpen_thread_reads` and the
condition `seen_through IS NULL OR t.last_message_at > seen_through`. A thread the
agent has already processed (and whose state hasn't changed) is no longer injected.

### Write path

`markThreadsSeen(agentId, threadIds)` upserts `seen_through` to each thread's
*current* `last_message_at` (read inside the upsert, so the runtime only passes
IDs), using `GREATEST` so the watermark is monotonic.

The runtime accumulates the set of thread IDs it injected across the task's
`refreshBullpenContext` calls (plus the woke thread, if the task is bullpen-origin),
and calls `markThreadsSeen` once at **successful** task completion. Early returns
(clarification pause, budget exhaustion, error fallback) intentionally do not stamp,
so an unfinished thread gets another turn.

### Why stamp at completion, not at injection

`refreshBullpenContext` runs before every LLM round to keep thread state fresh
(#213). Stamping at injection would filter the thread out mid-task and break that
continuity. Stamping at completion keeps the thread visible for the whole task and
only affects *future* tasks.

## Relationship to closing

The watermark fixes re-action without closing the thread. Threads still close via
the existing `close_after` convention (#881) when an agent concludes a discussion
in-thread; request threads simply age out of the window and sit inert (and
watermarked). Open-thread accumulation is now a cosmetic DB concern, not a
functional one, so this change removes the send-specific auto-close entirely.

## Acceptance criteria (revised from the issue)

- A thread the coordinator has handled is no longer injected into its context on a
  later wake, even though it remains `status='open'`. (the no-duplicate guarantee)
- A *new* message in that thread re-surfaces it (the watermark only suppresses
  already-seen state).
- Works for any action, not just sends — there is no skill allowlist.
