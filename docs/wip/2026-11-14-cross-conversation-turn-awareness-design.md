# Cross-conversation turn awareness — design (#2588)

Date: 2026-11-14
Issue: [#2588](https://github.com/josephfung/curia/issues/2588)
Extends: [ADR-053](../adr/053-turn-lanes-and-mid-turn-injection.md) (turn lanes, #2018), [ADR-019](../adr/019-delegation-aware-outbound-context.md) (outbound-context bridge)

## Implementation notes (deviations, 2026-11-14)

What was built differs from the design below in these places. ADR-053's "Cross-conversation
awareness (#2588)" section describes the built behaviour.

**Narrows a decision made with the principal (decision 2, §3).** A held call shows the
other turn's tool, target and time only when the turn whose call is held is the principal's, Curia's own
work, or the same resolved contact's. Any other person's turn gets one generic line
("Another turn already acted on this same target recently."), not tool, target and time. This
came from the security review: detail let a stranger learn, and steer, the principal's
activity. Revert to detailed lines if the principal prefers them.

From the plan:

1. **State is an in-memory registry, not audit-log queries** (§1). It gives the synchronous
   first-wins check, avoids N+1 reads, and makes "running, including detached specialists"
   a property of the registry. A restart empties it (fail-open).
2. **The backstop result is actions only for every caller.** The person's words reach the
   coordinator only through the turn-start note.
3. **Target precedence** (§3). Contacts and site hosts first. Other ids, and failing those
   the tool name, only when a call has neither. A shared mailbox id no longer makes
   unrelated sends collide.
4. **The hand-off tool is pushed into the turn's tool list by code and intercepted in the
   runtime**, not packaged as an activated skill (Constraints). It is not pinned; the
   coordinator's budgets are unchanged and no `ToolContext` field was added.

From rulings during the build:

- **Fallback target** is other ids if any, else the tool name, never both (§3).
- **Email addresses resolve to contact targets.** Calendar attendees carry addresses, not
  UUIDs, so the §3 premise was wrong. The principal's and Curia's own addresses and Curia's
  own contact are excluded too. Sites are URL hosts (`www.` stripped), not registrable domains.
- **Unresolved actors don't hold.** Actions by a root whose originator is unresolved hold no
  one; its own calls are still checked.
- **Outcomes** (§3 "outcome when known"): `pending`, `succeeded`, `unknown`. A failed call is
  removed. A timeout or a thrown error is `unknown`, since a throw can follow a side effect.
- **System vs person is judged by originator, not channel.** No originator, or a `system` or
  `agent` role, is Curia's own work. A malformed originator is an unresolved person.
  Voice-session delegations and async-offramp tasks join the call's root.
- **A human-approved replay is recorded, never held.**
- **Holds don't count toward `maxConsecutiveErrors` or `failedSkills`** (a marker, no
  `ToolResult` change).
- **An ended root in the caller's own conversation does not hold it**; one still running
  there does (plan deviation 5).
- **Caps:** 200 actions per root, global caps on roots and actions; a root running past six
  hours is treated as ended.
- **Scope hook for the suites:** smoke and scenario runs pass one registry scope per attempt.
- **The note leaves out turns in the same conversation** (lanes already serialise them).
- **The note's request text is the sender's own text**, stamped by the dispatcher into trusted
  task metadata, not task content (which can carry preamble and other people's words). It is
  withheld when the inbound's scan count is not a known zero. The note stays in the system
  string, JSON-quoted.
- **Email one-to-one** reuses `contact-recent-history`'s private-audience rule.
- **Hand-off eligibility:** the note's hand-off line and the tool appear only with lanes on, an
  eligible handing turn (the root inbound, full unclipped text, no follow-up drained since,
  clean scan, a sender the channel authenticated, SMS excepted as in `authority.ts`), and the
  tool actually in the turn's tools (no allowlist, registered). An email with a quoted or
  forwarded part cut off counts as clipped. Otherwise the turn does the work itself.
- **Who reads the note:** a person's inbound root turn only (not a wake, a delegated task or a
  synthetic turn other than a hand-off recovery), on a laned human channel, with a one-to-one
  audience. Groups, channel threads and cc'd email get none; scheduled jobs and wakes get none.
  Listed turns are laned human-channel roots only.
- **Sign-in codes:** no sender text is stamped when any code registered (any verification
  status) or the lookup failed; the note and the hand-off scrub tracked codes again at use.
- **Held corrections carry `liveTurn: false`** (#1126); a direct inject copies the handing
  task's own `liveTurn`.
- **The handing turn waits up to 30 s** for the target to drain the message, then reports it
  as passed on. `tryInjectIntoTask` is given the target's conversation and refuses a lane
  held elsewhere.
- **Recovery:** a correction the person was told was passed on or held, then lost in process
  (late return, not taken within 10 minutes, root ended or dropped with it held, a wake that
  cannot take it), is re-run as a synthetic coordinator turn on the handing conversation,
  modelled on the late-delegation wake. A restart still loses it.
- **Decline reasons** each have their own phrase: finished, no longer active, busy (no lane),
  not the same person, not one-to-one, cap, closing, ineligible, tool error, internal error.
- **Testing:** the scenario harness can't run two turns at once, so scenarios cover the
  finished-turn path and the live hand-off is integration-tested only.

## Why

Curia should behave like one assistant, even when the same person reaches it on several
channels at once. Today each conversation runs its own coordinator turn, and a turn on one
conversation can't see a turn on another. #2018 fixed overlap *within* one conversation.
Nothing covers overlap *across* conversations.

### The incident, re-read

The issue frames 2026-11-11 as "the same request on two channels". The principal's account
shows otherwise.

1. They forwarded a work email to Curia, asking it to pick a time on the contact's booking
   link and add the contact. That started Turn 1.
2. On Signal they asked whether their work address was on file. Curia answered yes.
3. On Signal they then sent a heads-up saying they had just sent two scheduling items and to
   flag any problems. That started Turn 2.

Message 3 was a **heads-up, not a request**. Turn 2 read it as "go do those two things",
found the forwarded mail, and redid the work Turn 1 was already doing. When Turn 2 started
(~17:06), Turn 1 had been running for about two minutes. Turn lanes already knew a turn for
the principal was in flight on another conversation. Nothing told Turn 2.

## Goals

The principal's words describe the target behaviour:

- **(a) Heads-up.** When a message refers to work already underway on another channel, reply
  along the lines of *"Yep, got them, they're in progress already."* Do not start the work again.
- **(b) Real duplicate.** When a message looks like the same request as work already
  underway, ask: *"Is that the same thing you just emailed me about, or something different?
  I don't want to accidentally double-book."*
- **(c) Correction.** When a message changes work already underway ("about that email,
  actually book Monday or Tuesday"), the correction takes effect. It is not blocked, and the
  booking is not doubled.
- **(d) Backstop.** When two turns start too close together to see each other, the second
  one still sees the first one's side effects before it commits its own.
- **One confirmation.** The principal gets exactly one confirmation of the outcome, never one
  per channel.

## Non-goals

- **Hard locks or claims keyed per action.** The principal chose model judgment over hard
  blocks: "LLMs are good for judging in ambiguity, and it's impossible to hard-code every
  permutation."
- **Serialising all of one person's turns.** Unrelated concurrent requests keep running in
  parallel.
- **Multi-process coordination.** ADR-053 §7 still applies: one Curia per database.
- **Cancelling a running turn so another can take over.** Stopping a turn halfway can leave
  things half done, such as a calendar hold with no confirmation sent.

## Anti-goals (would be failure even if it "works")

- Any added wait, or extra question, on ordinary single-channel use, or on two unrelated
  concurrent requests. The model must not get into the habit of asking "is this related?".
- One person's request text shown to a turn that is serving a different person.
- New storage (a table, or a config key that has to be kept in someone's head) where existing
  state already carries the facts. The principal asked explicitly to minimise new
  infrastructure. See also `docs/dev/principles.md` "Look for an existing mechanism".

## Decided with the principal

1. **Dividing line: same person, not "the principal".** A turn gets the full view of another
   turn, meaning what was asked and what was done, only when both turns serve the same
   resolved contact. This is the contact boundary ADR-053 §2 already draws for injection,
   extended across conversations. It covers the principal on email plus Signal, and equally a
   third party who confirms by email and then corrects by text.
2. **Every turn gets the actions-only backstop.** Every turn, including other people's mail
   and scheduled or synthetic turns, sees *what other turns did* before it takes a risky
   action. It never sees what a different person asked. This catches the case where a contact
   replies "Tuesday works" while the principal's turn is booking them, and a scheduled drafts
   run racing the principal's "send the first draft".
3. **See and decide, no hard block.** At the backstop, the turn is shown the other turns'
   actions and the model decides.
4. **Window: overlap plus 15 minutes.** "Other turns" means turns that overlap this one, plus
   turns that ended within 15 minutes before this one started. A turn that finished before
   this turn's risky step still counts.
5. **Corrections are handed into the running turn.** The second turn does not do the work
   itself. It passes the person's message into the turn already doing the work, using
   ADR-053's mid-turn injection, now across conversations. That turn stays the only one that
   books. If the earlier turn has already finished (within the window), the new turn does the
   work itself, seeing and adjusting what was done, e.g. moving the booking rather than adding
   one.
6. **One confirmation.** It goes on the channel the person used last by default. If there's a
   lot of detail, the model may judge that email suits better. This is the principal's weak
   preference: either channel is fine, both is not.
7. **Risky means `action_risk` medium or above, and targets are read from the call.**
   No new manifest field and no hand-maintained list. See §3.
8. **Voice gets the backstop only** (§6). Third-party confirmations follow the same "last
   channel used" rule as the principal's (§5). A small coordinator tool-budget raise is
   approved as a fallback (Constraints).
9. **No new ADR.** Amend ADR-053 with a cross-conversation section (decision, rejected
   options, consequences). Update the relevant spec text. This doc is the working design.

## Rejected options (for the ADR-053 amendment)

- **Claim before external side effects** (issue option 1). This would need a claim key per
  action type: booking, email, SMS, purchase, queue item, and so on. A list like that never
  closes, and the principal ruled out hard-coding the permutations. It also does nothing for
  (a) and (c). The backstop in this design keeps the useful part, a check just before the
  side effect, without keys.
- **Principal-scoped lane** (issue option 2). This serialises unrelated requests, so latency
  falls on normal use. Intake also can't tell "related" from "unrelated"; only the model can,
  after reading the message. And it covers only the principal, not a third party on two
  channels.
- **Cross-conversation awareness at turn start only** (issue option 3 as written). It misses
  turns that start within seconds of each other, and turns whose side effect happens after
  the other turn's start. That is why the pre-action backstop is added.

## The design

### 1. "Other turns" and where the facts come from

The facts come from **existing records**: the audit log, which already holds each `agent.task`,
its `tool.invoke` / `tool.result` children and the `inbound.message` it was parented on, plus
turn lanes for "is it still running". `src/autonomy/send-evidence.ts` already walks a delegated
specialist's task back to its root turn through `delegationOrigin`, and reads a root's inbound
and its tool results. Reuse that walk.

- **Root turn.** Delegated specialist work belongs to the coordinator turn that started it.
  In the incident the booking and both emails were done by specialists: calendar, and the
  browser via calendar.
- **Other turns of mine** are root turns other than my own root that either overlap my root,
  or ended at most 15 minutes before my root started. The 15 minutes is a code constant, not a
  config key. Overlap includes turns that started after mine, and turns that have finished
  since.
- **Same person** means both roots carry the same resolved contact UUID as originator, with
  the same fail-closed checks as ADR-053 §2. An unresolved sender is never "same person".
  Scheduled jobs have no person originator and are never "same person". *(My call, from the
  builder check.)* Continuation turns that restore an originator are the same person as that
  originator, following the code. That covers the late-delegation wake (`syntheticTurn: true`,
  originator restored from the handle) and the secret-capture resume. They count as part of
  the root they continue.
- **Running** *(my call)*: a root is running while its coordinator turn holds a lane, **or**
  while one of its delegated specialists is still working detached under late delivery
  (ADR-053 §9, `delegate` returned `in_progress`). Otherwise a booking still under way in a
  detached calendar or browser specialist would look "finished", and a correction would redo
  it.

### 2. Turn-start note (same person only)

The note is injected into the system string the way the "Sign-in verifications" block is
(`src/agents/prompts/verification-block.ts`, wired in `src/agents/system-prompt.ts`). That is
ADR-046's "injection with its trigger" rung. With no other same-person turn in the window,
nothing is injected and the prompt budget is unaffected.

For each other same-person turn, the note gives:

- the channel;
- running or finished, with times in local time;
- what the person asked, as their own words, labelled as data;
- the risky actions taken so far (see §3 for what counts as risky).

Brief guidance travels with the note and covers the three moves:

- **Heads-up:** acknowledge it.
- **Looks like the same request:** ask whether it is the same thing.
- **Correction or addition to work in flight:** hand it over (§4).
- **Anything unrelated:** just do it, with no question.

The guidance should stress the last case, because over-asking is the anti-goal.

### 3. Pre-action backstop (every turn)

Just before a **risky** tool call executes, in the execution layer next to the existing
`action_risk` checks in `src/skills/execution.ts`, look up risky actions by my other turns
(§1, any person) **on the same target** that my root has not yet been shown.

**Risky** (decided with the principal) means `action_risk` **medium or above**, read from the
manifests that already declare it. That covers custom tools and MCP servers with no extra
work. A send to the principal alone is exempt (#2337): messaging the principal is not a
duplicate side effect worth pausing for. No new manifest field, and no tool's `action_risk`
changes. A hand-maintained list and a new `tool.json` field were both considered and rejected
(they don't scale, and the field adds public API surface).

**Targets are read from the call itself** (decided with the principal). They are not declared
per tool. A call's targets are:

- every contact UUID in its inputs. Since ADR-047, sends, drafts and calendar invites address
  people by contact UUID;
- the registrable domain of every URL in its inputs (e.g. `cal.com`);
- every other id-shaped input value (a draft id, a card or merchant id);
- **excluding** the principal's own contact UUID and calendar ids, which appear in almost
  every call and would make everything collide;
- with none of the above, the tool name itself. The call then collides only with another
  turn's use of the same tool.

**Same target only.** Two unrelated concurrent requests touch different targets, so neither
is held. That is the anti-goal guard, and the "unrelated work is not slowed" test depends on
it. It also limits what a different-person turn learns: only actions on the target it is
itself about to touch. A generic read will sometimes match unrelated work (two turns both on
a common site). That costs one pause with a note, then the model carries on, and the
principal accepted that trade.

**At most one pause per (other root, target) pair.** Once a root has been shown "that turn is
working with that contact / on `cal.com`", further actions by that turn on that target don't pause it
again. In the incident this pause lands when Turn 2 *opens* the contact's booking link, before any
booking step.

**Recording** *(my call)*. A risky call that passes the backstop is recorded, synchronously,
in an in-process registry: root, target, tool, time and outcome when known. The check and the
record happen in one synchronous step, with no `await` between them, the same discipline as
`TurnLanes`. So of two near-simultaneous turns, the first passes and the second is held.
Neither can hold the other in a loop, and they can't both stand down. A held call is not
recorded, so an attempt never counts as an action; only a call that went ahead does. The
audit log supplies display detail, such as the result once it lands. Entries expire after the
window. A process restart empties the registry, which is accepted (single process, ADR-053
§7) and is the same fail-open choice as below.

- **No unshown (other root, target) pair:** the call proceeds. The registry check is in
  memory and adds no wait.
- **An unshown pair:** the call is not executed this time. The tool result tells the model
  what the other turns did on this target, and that it can re-issue the call if it still
  applies. The re-issued call proceeds.
- **"Shown" is tracked per root** *(my call)*, not per task. A coordinator that re-delegates
  after a held specialist call is not held again on the same pairs.
- **Who decides** *(my call)*: whoever made the call. Usually that's the specialist, as in the
  incident, where calendar and the browser did the booking. The held result carries its own
  guidance, so no budgeted agent's prompt grows. The guidance: "if you can't tell whether this
  still applies, return to the coordinator saying what you saw". Specialists get actions only,
  even for same-person turns. The person's own words reach the coordinator through the §2
  note, not through a specialist's tool result.
- **Different-person turns** see actions only: tool, target display name and time. They
  never see request text, message bodies or secret values. Even those hold details go only
  to a system turn, or to an authenticated sender (web, CLI and SMS count) in a one-to-one
  conversation who is the principal or the same person; anyone else gets a generic line. A
  turn whose sender is not authenticated is never labelled "your other conversation" (plan
  deviation 6).

The check **fails open**. If the registry or audit read errors, log at error level and let
the call proceed. This is a duplicate-avoidance aid, not an authorisation gate. Blocking every
risky action when the audit log is slow would be worse than the rare duplicate.

### 4. Hand-off of a correction into the running turn

When the model decides the person's message corrects or adds to a same-person turn that is
still running, it hands the message to that turn and replies with a short acknowledgement,
e.g. "Got it, I've passed that on; aiming for Monday or Tuesday". It then ends its turn
without doing the work.

- Delivery reuses ADR-053's injection: the queued input, drain at turn start, each round and
  exit, and the per-turn cap and extra rounds. The same checks apply: same resolved contact
  UUID, not auto-generated, zero injection-scanner findings. The one change is that the target
  is looked up by task across conversations, not by this conversation's lane.
- **Audience guard** (enforced in code): hand off only into a turn whose conversation is
  one-to-one with that same person. If the target conversation has other participants (e.g.
  the principal cc'd a third party on the mail to Curia), the hand-off is refused. Otherwise text the
  person sent privately on Slack could end up quoted in a reply to a thread with others.
  *(My call)* When the hand-off is refused, the new turn makes the correction itself. Its own
  risky calls go through the backstop, and so do the other turn's. When the other turn reaches
  its booking, it is held on the same target, sees the new turn's booking, and (same person)
  has the correction in its turn-start context; it stands down. If the other turn already
  booked, the new turn sees that booking and moves it.
- If the target has finished, or finishes before draining, the hand-off fails. The handing
  turn is told so and does the work itself, seeing the finished turn's actions.
- **Detached specialist still working** *(my call)*. The root's coordinator turn has ended,
  but its calendar or browser specialist is still booking under late delivery. Specialists
  take no injection, so the correction is held for that root's late-delegation wake and
  delivered into the wake turn at its `turn_start`, as a same-contact input. That is the same
  shape ADR-053 already allows for the 10-06 resume. The handing turn tells the person it will
  be applied once the booking lands. The holding place is in memory, like the lane queue. If
  the process restarts before the wake, the correction is lost and inbound replay does not
  cover it. That is accepted: the wake's own report to the person shows the original booking,
  and the person can correct it again.
- The receiving turn sees the injected message labelled with the channel it came from.
- If the earlier turn already committed the action (it booked before the correction drained),
  it adjusts the booking rather than adding one. ADR-053 Consequences already says committed
  side effects stay committed and are visible in the transcript.

### 5. One confirmation

- **Handed off:** the handing turn's acknowledgement is not the confirmation. The receiving
  turn delivers the single confirmation of the outcome. By default that goes on the channel
  the person used last, i.e. the hand-off's source channel, unless there's a lot of detail and
  the model judges email better. The receiving turn must not also post a separate
  confirmation on its own channel.
- **Heads-up (a):** the acknowledging turn says "in progress" and the running turn confirms
  as it would anyway. That's one confirmation, plus a quick ack the person explicitly asked for.
- **Third parties** (decided with the principal): the same "last channel used" rule applies.
  One difference is mechanical. Confirming a third party on their other channel is a separate
  send, through the autonomy gates, Gate C and band review. If that send would need the
  principal's approval, the turn replies on its own channel instead, so a confirmation never
  turns into an approval request.

### 6. Voice

Voice gets **the pre-action backstop only** (decided with the principal; voice may be less
robust than the text channels). There is no turn-start note and no hand-off.

- A call session is its own root. Its risky tool calls are checked and recorded in the
  §3 registry like any other turn's.
- So a call that tries to book or send on a target another turn is already working on hears
  about it, e.g. "already booked Wed 11:00 by another turn".
- And a booking made during a call is visible to other turns' backstops.

Voice tool calls are audited with the session id as `taskEventId`, parented on the
`inbound.message` (`src/channels/voice/voice-tool-audit.ts`). They don't pass through
`agent.task`, so the §1 root walk must treat the session id as the root rather than fail to
place it. The builder confirms that voice tool calls reach the same `src/skills/execution.ts`
path. If they don't, the check is added at the voice tool path.

## Constraints

- **Single process.** Turn-lane state is in memory (ADR-053 §7). The audit log is the
  durable source for "what was done".
- **No new table and no new config key.** The 15-minute window is a constant. The only new
  state is two in-memory structures: the backstop's action registry (§3) and the held
  corrections waiting for a wake (§4). The backstop and
  note are always on. The hand-off rides the existing `dispatch.turnInjection.enabled` flag,
  because without injection there is nothing to hand into.
- **Prompt budget.** The note and the backstop result are trigger-time injections and add
  nothing to the always-on prompt. The coordinator's local tool-definition budget has about
  20 bytes of headroom (`tests/unit/agents/prompt-budget.test.ts`). So the hand-off tool is
  exposed through skill activation (`src/skills/skill-activation.ts`), switched on by code for
  the turn only when the §2 note is injected, the way the coordinator activates
  google-workspace on demand. Then it costs nothing on ordinary turns. **Fallback, approved by
  the principal:** if activation can't be driven per turn by code, raise the coordinator's
  `localToolDefinitionBytes` by the hand-off tool's measured size (expected ~600–800 bytes),
  and state that delta in the budget test's comment, as earlier raises did.
- **Untrusted text.** A person's own words shown to another turn are data, labelled as such,
  in the same style as `RECIPIENT_MESSAGE_UNTRUSTED_NOTE`.
- **Public repo.** Test fixtures and docs use synthetic names. Nothing from prod.

## Testing (maps to the issue's acceptance criteria)

- **Integration, scripted model** (free, CI). Reproduce the incident: an email turn and a
  Signal turn for the same contact, a few seconds apart, both reaching a booking step and a
  send to the same third party. Assert:
  - the second turn's risky call is held once and shown the first turn's actions;
  - when the scripted model then declines, exactly one booking and one outbound email result.

  This tests the mechanism. Model judgment is covered by the scenarios below.
- **Integration: unrelated work is not slowed.** Two same-person turns on unrelated requests
  with no overlapping risky actions both complete with no held calls. A single-channel turn
  gets no note and no held calls.
- **Integration: actions only across people.** The backstop result shown to a
  different-person turn contains no request text or message body.
- **Integration: hand-off.** Delivered into a running one-to-one turn. Refused into a
  multi-participant conversation. Falls back when the target has already finished.
- **Unit tests:** the window and overlap computation, target extraction (contact UUIDs, URL
  domains, other ids, principal exclusions, tool-name fallback), one pause per pair,
  first-wins on a synchronous tie, fail-open on registry or audit errors, and "shown"
  tracking per root.
- **Voice:** a voice-session call on a target another turn is working on is held once.
- **Scenario cases** (written, not run until the maintainer agrees to the cost): heads-up
  → acknowledge; real duplicate → ask; correction → hand-off and a single booking on the new
  day; unrelated concurrent requests → no question.

## Left to the builder

- Exact text and layout of the note and the backstop result.
- The hand-off tool's name and inputs, within the exposure rule in Constraints.
- The exact id-shape rules for target extraction (§3), and how calendar ids are recognised
  as the principal's.
- Audit-log query shape and indexing for the §2 note, within a hard `LIMIT`.
- Whether turn-lane holders need any extra field for "still running" across conversations.
- PR breakdown and order.
- The wording of the ADR-053 amendment and spec edits.
