# ADR-053: Turn lanes and mid-turn injection

Date: 2026-10-24
Status: Accepted
Amended: 2026-10-26 — the shipped flag is on, resting on the passing case 26 run on the release-gate model and judge (#2018)
Amended: 2026-11-14 — cross-conversation awareness (#2588)

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

*Amended 2026-10-30.* The `POST /api/messages` example in item 8 has no route anymore (ADR-057). Turn injection itself is unchanged for the channels that still publish inbound messages.

*Amended 2026-10-26.* The shipped file sets `enabled` true. That rests on case 26, `mid-turn correction switches the sign-in channel`, commit `1db43195`: 3 runs, model `deepseek/deepseek-v4.1-flash`, judge `openai/gpt-4o`, critical checks 100%, every drain at `round:1`. An earlier run the same day, commit `a2bc516a`, failed because InferenceNet drops tool arguments after an `action` key. InferenceNet is excluded at the account level for that reason. An absent `enabled` field still resolves to false, and `enabled: false` does the same. With the flag on, email releases the next same-thread message when the dispatcher decides the inbound, so a same-contact follow-up can join the turn still running.

9. **Delegate wait.** When late delivery is on, a queued follow-up ends the wait early with `in_progress` rather than a timeout. The specialist keeps running. Its result arrives later as its own late-delegation wake, which waits in the lane. No other in-flight tool call is cancelled.

## Consequences

- The 2026-10-06 sequence becomes one turn: the resume holds the lane, the principal's email is the same contact, and it is drained into that turn. A different sender on the thread waits and is answered as the next turn, to their own recipients.
- A long tool call can delay a follow-up by at most that one call, except `delegate`, which returns early. Side effects already committed stay committed. The model sees them in its transcript.
- An inbound that was queued but not drained when the process stops stays unacknowledged, so inbound replay delivers it as a fresh turn.
- History keeps an injected row with the message it followed. The same-role collapse treats that pair as one group, so an injected row cannot erase the original.
- Voice is unchanged. It does not publish `agent.task` and does not use the exit hook.
- Turning the lane on without the injection path would make a live message wait behind a long synthetic turn. Injection is required whenever the lane is on.

## Cross-conversation awareness (#2588)

### Context

Lanes serialise turns within one conversation. Nothing covered two conversations. On 2026-11-11 the principal forwarded an email to Curia asking it to book time with an external contact through a booking link and add the contact. About two minutes later, on Signal, they sent a heads-up that two scheduling items were on their way. A second coordinator turn read the heads-up as a request, found the forwarded email and started the same work. Neither turn could see the other. Turn lanes already knew a turn for the principal was running on another conversation, but nothing told the second turn.

### Decision

1. **Turn activity registry.** An in-process `TurnActivityRegistry` (`src/dispatch/turn-activity.ts`) records root turns and the risky actions they take. A root is the turn a person started, plus every delegated specialist, late-delegation wake and voice-session task that continues it. The runtime reports task starts and ends. A root is running while any task under it runs, so a detached specialist under late delivery (§9) keeps its root running. "Other turns" means roots that overlap mine, or that ended at most 15 minutes before mine started (`TURN_ACTIVITY_WINDOW_MS`, a constant). Roots and actions are capped, and a root still running after six hours is treated as ended. There is no new table and no new config key.

2. **Pre-action backstop, every turn.** Just before a call at `action_risk` medium or above runs, `ExecutionLayer.invoke` reads the call's targets from its input (`src/dispatch/action-targets.ts`). No manifest declares them.
   - Contacts: contact UUIDs, and email addresses that resolve to a contact.
   - Sites: URL hosts.
   - Only when there is neither a contact nor a site: other id-shaped values, and with none of those, the tool name.
   - The principal's contact, Curia's own contact, the principal's addresses and Curia's mailboxes are never targets. A send to the principal alone is not checked.

   The check and the record are one synchronous step, with no `await` between them, so of two near-simultaneous turns the first proceeds and the second is held. A held call does not run and is not recorded. Its result tells the model what the other turn did, and that it may call again unchanged if the call still applies. Each root is held at most once per (other root, target) pair. A human-approved replay is recorded but never held. Every error fails open: it is logged and the call proceeds.

3. **Outcomes.** A recorded action is `pending` while its handler runs, then `succeeded`. A call that returns failure is removed: it did nothing to wait on. A timeout, or a thrown error that may have followed a side effect, leaves it `unknown`. A detailed hold line says which.

4. **Disclosure.** The hold names whose turn it was, the tool, the target and the local time only when the turn whose call is held is the principal's, Curia's own work (no originator, or a `system` or `agent` role), or the same resolved contact's. Any other viewer gets one generic line, "another conversation already acted on this same target". Request text and message bodies never appear in a hold. Actions recorded by a root whose originator is unresolved never hold another root; its own calls are still checked.

5. **Same-person note at turn start.** When the person who started a coordinator turn has other roots in the window, in other conversations, the runtime injects a note (`src/agents/prompts/other-turns-block.ts`). It lists each turn's channel, whether it is running, its times, what the person asked and the actions taken so far, with guidance for four moves: acknowledge a heads-up, ask about an apparent duplicate, hand over a correction, and simply do unrelated work. What the person asked is the sender's own text that the dispatcher stamps into trusted task metadata. It is JSON-quoted, labelled as data, and withheld when that inbound's injection-scan finding count is anything but a known zero. It is also run through the sign-in code tracker's scrub when the note is built, which catches a code registered after the stamp. Both roots must carry the same resolved contact UUID.
   - **Who reads it.** Only a person's own inbound root turn: the root task itself (not a wake or a delegated task under it), not a synthetic turn, a coordinator turn on a laned human channel (no scheduled job, internal or bullpen task), and a one-to-one audience by the §6 rule. A group, a channel thread or an email with others on it gets no note at all, so one person's words are never shown where others read the reply. The one synthetic exception is a hand-off recovery turn (§8), which re-runs the person's own message. A stranger and an unresolved sender get no note.
   - **What it lists.** Only other roots on laned human channels. A scheduler, internal, bullpen or voice root is not listed, even when it carries the person's originator.
   - **Sign-in codes.** The dispatcher stamps no sender text when the message may carry a code: when any candidate registered against any verification (pending, expired or abandoned), or when the verification lookup failed (logged at warn).

6. **One-to-one audience guard.** A hand-off goes only into a conversation that is one-to-one with the same person (`src/dispatch/audience.ts`): a Signal chat that is not a group, a Slack DM, SMS, or an email thread that passes the private-audience rule `contact-recent-history` already uses. Any other conversation fails closed.

7. **Hand-off.** The coordinator gets `turn-handoff` only when the note shows hand-off guidance, and the guidance shows only when the tool is actually in the turn's tools: no per-turn allowlist, an execution layer, and a registered definition (a suppression is logged at warn). It also requires lanes to be on and the handing turn to be eligible: the person's root inbound turn, with their full text (not clipped, no follow-up drained since; an email with a quoted or forwarded part cut off counts as clipped) and a clean scan, from a sender the channel authenticated. The authentication is the dispatcher's `originator.authenticated` stamp, so a forged email From that resolves to the principal cannot pass its text into an authenticated turn. SMS is the one exception, the same accepted risk `isPrincipalDirectedMailboxSend` makes. The runtime pushes the tool definition into that turn's tool list and intercepts the call (`src/agents/turn-handoff.ts`). The tool is not pinned, so the coordinator's prompt and tool-definition budgets are unchanged. Discovery can still surface the tool on another turn, but the runtime re-checks every condition when it intercepts the call. The model passes only the target turn's id. The text handed over is the stamped sender text, scrubbed of tracked sign-in codes, never the model's input. Its `liveTurn` copies the handing task's own. Delivery uses `TurnLanes.tryInjectIntoTask`, which is §2's injection with the host found by task id instead of by this conversation's lane, under the same checks; the hand-off also passes the target's conversation id, and a lane held on any other conversation is refused. The handing turn waits up to 30 seconds for the target to drain the message, then reports it as passed on. The receiving turn sees the message framed as handed over from the named channel. Otherwise the tool tells the model to do the work itself, with a reason of its own: the target finished, is no longer active (out of the window), is busy with no lane to take messages, is at its cap, is closing, fails the audience guard, the tool call failed, or an internal error.

8. **Held corrections for detached specialists, and recovery.** When only a detached specialist is still working under the target root, the correction is held in the registry (at most five per root) and drained at turn start into that root's late-delegation wake. A held input carries `liveTurn: false`, because a wake never carries the live-turn signal across an async boundary (#1126). Whether the detached work is a late-delivery delegation is not cheaply knowable in process, so any detached task qualifies and recovery covers the rest.

   Once the person has been told a message was passed on or held, an in-process loss is never only a log line. `recoverHandoff` publishes a fresh synthetic coordinator `agent.task` on the handing root's own conversation and channel, carrying its stamped originator, with `liveTurn` absent, `metadata.handoffRecovery: { targetRootId, reason }`, and a short framed preamble followed by the person's own text, scrubbed of sign-in codes (`src/agents/handoff-recovery.ts`). It follows the late-delegation wake: a `system`-layer publish, dispatcher routing registered first, and a deterministic event id so audit_log's primary key fences a duplicate. It goes through the lanes like every synthetic turn (§4), so it waits its turn on that conversation, and the note and the backstop keep it from repeating the other turn's work. The triggers: a passed-on message that comes back undrained after the handing turn reported it passed on; one neither drained nor returned ten minutes after it was queued (`HANDOFF_LOST_AFTER_MS`, which also covers a follow-up retained for an audit retry that never flushes); a root that ends, or is pruned or evicted, with corrections still held; and a wake that cannot take a held correction or ends without draining it.

9. **Holds are not tool errors.** A held result is `success: false`, so the model re-issues rather than assuming the work ran. A marker keeps it out of the runtime's `maxConsecutiveErrors` count. `ToolResult` is unchanged.

10. **Voice gets the backstop only.** A call session is its own root, registered on its first risky tool call. Specialists delegated from a call and async-offramp tasks join that session's root. Voice gets no note and no hand-off.

11. **Test scope isolation.** The registry takes an optional scope function. The smoke and scenario harnesses pass one scope per case attempt, so concurrent cases never hold each other. Production passes none.

### Rejected options

- **Per-action claims or locks before external side effects.** They need a claim key per kind of action: booking, email, SMS, purchase, queue item and more. That list never closes. The principal preferred model judgment to hard-coded permutations. Claims also do nothing for a heads-up or a correction.
- **A principal-scoped lane.** It serialises unrelated requests, so latency falls on normal use. Intake cannot tell related from unrelated; only the model can, after reading the message. It also covers only the principal, not another person on two channels.
- **Awareness at turn start only.** It misses turns that start within seconds of each other, and side effects that land after the other turn started. The pre-action backstop covers those.
- **A new `tool.json` target field.** It adds public API surface. Custom and MCP tools would get no coverage until someone authored the field for each of them.
- **A hand-maintained list of risky tools.** It goes stale. `action_risk` already ranks every tool.
- **Audit-log queries as the source of truth.** They cannot give a synchronous first-wins check, and they cost N+1 reads per risky call. The registry keeps what the runtime and execution layer already see.

### Consequences

- A restart empties the registry. Turns that were running before it are invisible afterwards. This fails open, like the lane (§7).
- Single-channel use waits for nothing new. The check is in memory. With no other root in the window, no note is injected and no call is held. Unrelated concurrent work touches different targets and is not held.
- A correction held for a wake, or queued into a running turn and not yet drained, is lost if the process restarts first. Inbound replay does not cover it. Any in-process loss is re-run on the handing turn (§8).
- A recovery turn can arrive after the target turn did take the message late (it drained after the ten-minute timer). The note and the backstop are what keep the second pass from repeating work.
- The existing same-conversation follow-up path (`tryInject` in the dispatcher, #2018) does not check the sender's channel authentication; that gap predates this decision and is unchanged.
- The scenario harness cannot run two turns at once. Scenarios cover the finished-turn path. The live hand-off into a running turn is covered by integration tests only.
- The generic hold line still tells another person's turn that something acted on the same target recently. That one bit is accepted.
- A pair that collides on a shared site or id when the work is unrelated costs one pause with a note, then the model carries on.
