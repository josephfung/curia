# ADR-053: Turn lanes and mid-turn injection

Date: 2026-10-24
Status: Accepted
Amended: 2026-10-26 — the shipped flag is on, resting on the passing case 26 run on the release-gate model and judge (#2018)

## Context

On 2026-10-06 a secret-capture resume and the principal's next email ran as two coordinator turns on the same email conversation. Each read history once, at the start, and neither could see the other. The resume chose SMS for a sign-in code; the email, which had asked for email, chose email. Two browser sessions, two codes, two contradictory replies.

Nothing recorded "a coordinator turn is in flight for conversation X". `AgentRuntime.register` runs every `agent.task` immediately. The dispatcher's routing table is per task. Since #2282 the email adapter queues a second live message on a thread until the first turn finishes, but synthetic wakes do not go through that adapter, and Signal, Slack, SMS, HTTP, and CLI have no per-conversation guard.

`await bus.publish()` does not return until every subscriber finishes, including the whole coordinator turn. A guard has to work with that. It cannot defer the publish.

Alternatives considered and rejected:

- **Serialize every turn and stop there.** A live correction would wait behind a long synthetic turn. The resume in the incident ran for seventeen minutes. [ADR-023](023-bullpen-consult-and-resume.md) rejects holding a person's turn open for that. Serialization stays as the fallback for input that cannot be injected. Email has worked that way since #2282.
- **Inject synthetic briefs into the running turn.** The late-wake lease and its duplicate fence, the content-block and delegation-retry attempt caps, the scheduler's `pendingJobs` completion, and `DelegationGuard` seeding are all keyed by the synthetic task's own id. `resumeToken` and `blockedDraft` are not payload fields that could be carried across. Injecting those briefs would break the mechanisms. They wait, and then run as themselves.
- **Let the principal inject into any running turn, or any sender inject into a principal turn.** A third party's message would ride the principal's turn, or the reverse. Reply-lock and Gate C are per task and assume one counterparty. That needs a per-input routing set this design does not have.

## Decision

1. **One holder per human conversation.** An in-process `TurnLanes` map, keyed by `conversationId`, tracks the coordinator task that holds the lane and a FIFO of waiters. Laned tasks are coordinator tasks that are not delegated specialist work, on any channel except `scheduler`, `internal`, `bullpen`, and `voice`. The dispatcher reserves the lane synchronously when it creates a task, so two arrivals cannot both see an empty lane. The runtime acquires before `handleTask`, which also covers tasks published by the synthetic paths. Those publishers are otherwise unchanged. The dispatcher stamps `originatorResolved` from the contact resolver at reserve time. A later acquire of the same task does not replace that stamp, so the runtime cannot widen it. A task that never reserved is injectable only when its copied originator could not be the unresolved branch: a UUID contact id, and either a system role or a tier of known, trusted, or principal. A raw sender id, a null role with tier unknown, and a Signal ACI all fail that check.

2. **Who may inject.** Only a live inbound from the same resolved contact as the holder's originator. `tryInject` checks this itself, and fails closed:
   - both contact ids are UUID-shaped and equal, with no case folding and no trimming;
   - the holder was stamped from a resolved contact, not from a raw channel sender id;
   - the follow-up's admission says it was resolved, not auto-generated, and had zero injection-scanner findings. A missing or non-integer finding count is refused.
   The principal flag is not an input. A display name is not an input. The queued record is a frozen copy taken at the check, and a display name is stored as a single line so it cannot break the framing line. The dispatcher also skips `tryInject` for an unresolved sender, auto-generated mail, or a message with scanner findings; the lane repeats those checks because a skipped call site must not become a hole.

3. **What injection does.** The follow-up has already been through the inbound pipeline. On `queued`, `handleInbound` awaits a ticket. `drained` means the runtime persisted it into the host turn and the inbound may be acknowledged. `returned`, or any `not_injected` result, means the message creates its own task and waits in the lane. The runtime drains at turn start, at each round, and, if the model has already produced final text, through an exit hook that keeps the unsent draft and runs another round. Five follow-ups per turn. Each one adds two rounds to that turn's budget. A reserved holder counts as holding, so a follow-up that arrives after reservation and before the first model call still joins the turn.

4. **Synthetic input waits.** Secret-capture resume, late-delegation wake, delegation retry, and content-block rewrite keep their own task ids and their own state. The lane makes them wait until the holder releases. It does not rewrite them.

5. **Release before `agent.response`.** The content-block rewrite task is published inside the host's own `agent.response` delivery. Releasing afterwards deadlocks. Every exit releases, and a `finally` releases again. The assistant row is persisted first, so the next holder reads it. Once the runtime decides the queue is empty it marks the hold closing in that same synchronous step; a later arrival is not injected.

6. **Fail-open.** A waiter that has waited `laneWaitTimeoutMs` (20 minutes) logs an error with the conversation id, the holder task id, and the wait, and runs anyway. It does not take the lane. A hang cannot swallow a message, and the timed-out task cannot release the real holder.

7. **One process.** The map is in memory. [ADR-051](051-knowledge-graph-embeddings-from-a-configurable-endpoint.md)'s instance lock is advisory at boot: a second Curia logs and continues without it. That lock does not serialize turns. A multi-process lane would be a Postgres advisory lock, and it is out of scope. One Curia per database remains the supported deployment.

8. **Flag.** `dispatch.turnInjection.enabled` defaults to false. Off means no lane method runs and behaviour is unchanged. It is turned on only after the pieces land and the mid-turn scenario has been run. With the flag on, a second message on Signal, Slack, SMS, HTTP, or CLI waits or is injected instead of running beside the first. That is a behaviour change. Email already waited. A second `POST /api/messages` on the same `conversation_id` while the first turn runs is injected; the first HTTP request still resolves as superseded, and the second request carries the single reply.

*Amended 2026-10-26.* The shipped file sets `enabled` true. That rests on case 26, `mid-turn correction switches the sign-in channel`, commit `1db43195`: 3 runs, model `deepseek/deepseek-v4.1-flash`, judge `openai/gpt-4o`, critical checks 100%, every drain at `round:1`. An earlier run the same day, commit `a2bc516a`, failed because InferenceNet drops tool arguments after an `action` key. InferenceNet is excluded at the account level for that reason. An absent `enabled` field still resolves to false, and `enabled: false` does the same. With the flag on, email releases the next same-thread message when the dispatcher decides the inbound, so a same-contact follow-up can join the turn still running.

9. **Delegate wait.** When late delivery is on, a queued follow-up ends the wait early with `in_progress` rather than a timeout. The specialist keeps running. Its result arrives later as its own late-delegation wake, which waits in the lane. No other in-flight tool call is cancelled.

## Consequences

- The 2026-10-06 sequence becomes one turn: the resume holds the lane, the principal's email is the same contact, and it is drained into that turn. A different sender on the thread waits and is answered as the next turn, to their own recipients.
- A long tool call can delay a follow-up by at most that one call, except `delegate`, which returns early. Side effects already committed stay committed. The model sees them in its transcript.
- An inbound that was queued but not drained when the process stops stays unacknowledged, so inbound replay delivers it as a fresh turn.
- History keeps an injected row with the message it followed. The same-role collapse treats that pair as one group, so an injected row cannot erase the original.
- Voice is unchanged. It does not publish `agent.task` and does not use the exit hook.
- Turning the lane on without the injection path would make a live message wait behind a long synthetic turn. Injection is required whenever the lane is on.
