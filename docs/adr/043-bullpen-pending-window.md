# ADR-043: Bullpen pending-thread window is seven days, in minutes

Date: 2026-09-24
Status: Accepted

## Context

`getPendingThreadsForAgent` is the catch-up path for a bullpen handoff whose `agent.discuss` dispatch did not land. The thread is already persisted. The next time the participant is woken on an interactive channel or a bullpen-origin task, the runtime injects open threads that participant has not seen and did not author the latest message on (#1065 watermark, latest-sender guard, `LIMIT 5`).

#1899 reported that path as dead because the window was 60 milliseconds. The public method has taken minutes since the original implementation and converted to milliseconds before the Postgres backend (`windowMinutes * 60 * 1000`, then `windowMs / 1000` at the SQL boundary). A call with `60` is sixty minutes, and the existing integration test — a two-hour-old thread excluded by a 60-minute window — passes under both the real conversion and a millisecond misread, so it never caught a unit error. The backend parameter was named `windowMs`, which is what made the caller and the predicate look like they disagreed.

The one-hour window is still the wrong shape for recovery. A missed handoff is often hours old before the target agent is woken again: ceo-inbox is quiet overnight, the coordinator is hourly, meeting-debrief runs three times a day, calendar is daily, and contacts is twice a week. The watermark already stops a handled thread from being re-actioned, so recency is only a backstop against abandoned threads, not the mechanism that prevents duplicate work.

Scheduler-channel tasks do not inject this tier at all (#1609). An unattended job with human-channel send tools pinned treated an ambient mention as something to answer, and the reply landed on the principal's Signal. Widening the window does not put pending threads back into cron ticks. Recovery is the next interactive or bullpen-origin wake.

## Decision

The pending-thread window is **seven days**, the `BULLPEN_PENDING_WINDOW_MINUTES` constant in `src/memory/bullpen.ts` (not an environment variable). Every layer of `getPendingThreadsForAgent` names the argument `windowMinutes`. The Postgres predicate converts with `windowMinutes * 60` seconds. The in-memory backend converts with `windowMinutes * 60 * 1000` milliseconds. The service passes the number through.

Seven days covers a contacts-agent gap (Wednesday to Monday, about five days) with slack for a delayed run, and it covers the hours-long gaps of the other schedules. It still drops a thread that has sat unseen for longer than a week.

Rejected alternatives:

- **Keep 60 minutes.** Misses any eligible wake later than an hour, which is the common case and the failure #1899 was tracing.
- **Drop the recency predicate and rely on the watermark plus `LIMIT 5`.** Recovers arbitrarily old open threads. A year-old request would re-enter context on the next eligible wake and invite a stale action. A bounded backstop is cheaper than that.
- **Lift the #1609 scheduler suppression.** That is what put internal bullpen chatter on the principal's Signal. A missed dispatch still has to be recovered on a wake that is allowed to see the tier, or by the primary dispatch path (#1898).

Injected message stamps use `toLocalIso` in the principal's timezone. A time-of-day-only stamp reads as "just now" once the window is longer than an hour, and a raw UTC stamp asks the model to convert.

Of the five pending slots, four are the newest eligible threads and one is the oldest that has not already been shown and left untouched, so newer traffic cannot keep a missed handoff out of the cap until it ages out of the window. A retry does not pin that oldest slot for the rest of the window.

The injected block tells the model the threads are ambient: answer them with the bullpen tools, and do not fold them into the reply on the channel that woke the agent. Scheduler suppression (#1609) still applies; this line covers the interactive path the suppression does not.

## Consequences

- An unread open thread whose latest message is 30 minutes old, or many hours old, is returned for a participant who has not seen it and did not speak last. A thread older than seven days is not. A seen thread and a thread the agent spoke last on stay excluded.
- Updated by #1901: an ambient thread is an open handoff when any message after the agent's own latest post @mentions them, so a later note with no mention does not retire the request. The first wake that leaves that handoff untouched keeps it pending and records the messages shown; the same messages shown again, still untouched, are marked seen, so a paraphrased out-of-band miss is not repeated for the whole window. An out-of-band handle counts when the call carries the thread id or an excerpt of the mention that does not also appear in another handoff shown on that turn. The watermark advances only through the newest message the agent was shown, so a mention that lands during the turn stays unseen. The thread a bullpen-origin wake was opened for is marked seen even when the agent does not reply.
- A bullpen block that does not fit the context budget is removed before the provider call, and those threads are not watermarked, so a later wake can try again. The `context.budget` event records `droppedReason: budget_exceeded` for a block that was actually omitted.
- Passing minutes into a milliseconds parameter, or the reverse, fails the Postgres integration test: a 30-minute-old row must be inside a 60-minute window and a 90-minute-old row must be outside it.
- Scheduler runs still do not see ambient bullpen threads. A specialist whose only wake is a cron tick will not pick up a lost handoff through this path.
