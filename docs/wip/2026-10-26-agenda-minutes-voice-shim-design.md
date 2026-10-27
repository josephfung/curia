# Agenda-and-minutes voice architecture

High-level design for driving a live voice call from a prepared agenda, keeping a
transcript of the call, turning it into **minutes** after the call, and handing the
minutes to the coordinator so it can structure and execute the follow-up work. It
builds on the existing thin voice shim (`VoiceRuntime` / voice tool bridge) rather
than adding a second spoken brain.

The design does not depend on the transport. The same contract applies to console
calls, Signal calls (#1672) and, later, Google Meet (#2231). Meet is one more way
for audio to reach the shim. This document defines what a call is for and what it
produces.

This is a design sketch, not an implementation spec.

## Decisions so far

- **Minutes are written after the call, not by the shim.** The shim stays thin; a
  post-call writer produces the minutes from the transcript (see *Minutes*).
- **One owner for structuring: the coordinator.** This applies to every call
  source, including 1:1s, onboarding, board meetings and leadership meetings. There
  is no per-source routing to different agents (see *Structuring pass*).
- **Role is free text.** At most one typed knob, the turn policy, is enforced in
  code, and it is not needed on day one (see *Role and turn policy*).
- **The handoff is deterministic.** It is driven by session end, not by the model
  remembering to call a tool (see *Deterministic handoff*).
- **Agenda and minutes land first, before the Meet transport.** The first slice is
  testable over the existing Signal voice channel (see *First slice*).

## Core concept

A call under this architecture has four parts, deliberately split:

1. **Agenda builder (upstream).** The coordinator, a routine or a person prepares
   what the call is about and resolves all source material into a self-contained
   payload.
2. **Voice shim (on the call).** The thin voice-only coordinator is the only voice
   anyone hears. It accepts the agenda at call start, behaves according to the
   agenda's role, and keeps its turns short. It does not write minutes, structure
   work, set up routines or grow a large tool set.
3. **Minutes writer (after the call).** A single agenda-aware compression of the
   transcript into human-readable minutes.
4. **Structuring pass (after the minutes).** The coordinator, with its full tool
   set and running asynchronously, turns the minutes into typed action items and
   executes them.

The shim stays lean on purpose. Spoken turns are short and can't be taken back, and
they run under a hard limit on tool rounds. Structure and side effects belong after
the call.

## Three layers of output

```
transcript   mechanical, lossless, speaker-labelled, streamed durably. No LLM.
   → minutes        one agenda-aware compression, post-call, standard tier
      → action items   typed and executed by the coordinator's structuring pass
```

Each layer has its own reader and its own retention:

- **Transcript:** the system of record for what was said. It may be kept for a
  shorter time.
- **Minutes:** what a human reads, and possibly shares with attendees.
- **Action items:** tasks, schedules, document edits and follow-ups.

Keeping the layers separate is also what makes a dropped call safe. The transcript
is already persisted as the call happens, so partial minutes are always possible.

## Agenda contract

An agenda is a small, explicit payload handed to the shim when the session starts.
One rule keeps it small:

> **Fields the runtime acts on are typed. Fields only the model reads go in the
> context blob.**

| Field | Typed? | Who consumes it | Day 1? |
|---|---|---|---|
| `title` | yes | prompt framing, minutes header | yes |
| `topics` | yes (ordered list) | prompt; the minutes writer infers coverage | yes |
| `role` | free text | the model only, never interpreted by code | yes |
| `context` | resolved blob | the model only | yes |
| `source` | yes (`principal`, `routine`, `coordinator`, `calendar`, `ad_hoc`) | provenance and the structuring prompt | yes |
| `sensitivity` | yes (`internal` default, `confidential`, `shareable`) | access to the minutes; future event consumers | yes |
| `roster` | yes (contact ids) | speaker naming and per-speaker trust, used by the bridge | no, multi-party only |
| `turnPolicy` | yes | turn gate before the LLM | no, see below |
| `timebox` | yes | topic pacing and session cap | maybe |

Who supplies it:

- **A routine** (e.g. a daily onboarding check-in) that already knows the day's
  focus.
- **The coordinator**, when it sets up a call after async work.
- **A person**, when the principal or an operator starts a call with a stated
  purpose.
- **The calendar** (with Meet, #2231): the auto-join wake-up builds the agenda from
  the event's title, description and attendees, plus resolved context such as prior
  minutes with these people and their open tasks.

An ad-hoc call ("Curia, join this link", or the principal just calling in) must
work with a title-only agenda, or with no agenda at all, which is today's free-form
behaviour.

## Role and turn policy

**`role` is free text.** It is how Curia should behave on this call: "participant",
"chair: keep time and move us through the topics", "observer", "host". Code never
interprets it. We are not fixing a role taxonomy before we have real use data. The
role text is recorded on the voice session so we can later see which roles keep
recurring and promote them to presets based on evidence.

**`turnPolicy` is the one behaviour code must enforce, because it acts before the
model runs:**

- `conversational` (default): every finished utterance is a turn. This is today's
  behaviour, and it is right for a 1:1.
- `addressed_only` (later, with Meet notetaker mode): only utterances addressed to
  Curia become turns. Everything else is transcribed but gets no reply. Barge-in
  applies only while Curia is speaking.
- `facilitate` (future idea, not scheduled): Curia only speaks up on critical
  meeting-process matters, such as running out of time, topic drift or an agenda
  item about to be missed. It is not a contributor to the discussion.

Day one ships **no** `turnPolicy`. A Signal 1:1 is always `conversational`.

**Tool posture does not come from the role.** Whether the shim may write during the
call (`task-create`, `memory-store`) is a trust property. It derives from *who is on
the call* (the roster and per-speaker attribution), never from role text the model
reads:

- **1:1 with the principal:** today's nine voice tools, unchanged.
- **Multi-party or `addressed_only`:** no write tools during the call. Requests like
  "Curia, capture that todo" become **marks** (see *Shim role*). Otherwise a
  non-principal speaker's claim could go straight into the knowledge graph through
  `memory-store`.

## Source material: resolve upstream, not on the call

Attachments, web pages, OKF documents and participant context must be **resolved
into a self-contained blob before the shim sees the agenda**. The shim has no way to
fetch anything, so references that are only pointers (paths, URLs, doc ids without
content) are useless on the call.

The agenda builder is therefore an async job, shaped like a coordinator task or an
equivalent upstream step. It gathers what the conversation needs and flattens it
into text the spoken model can use. Enough context for a short conversation beats a
perfect corpus. If material can't be resolved in time, the agenda should say what is
missing rather than point at an unresolved source.

This keeps the spoken prompt cacheable and the tool list fixed. It also matches
today's voice constraints: no documents bundle, no discovery, no skill activation
during the call.

## Shim role

On the call, the shim:

- greets the caller and frames the call from the agenda's title, topics and role;
- follows the agenda conversationally, one topic at a time, in brief spoken turns;
- stays the **only voice anyone hears**, so specialists and the full coordinator
  never speak;
- may use the small existing voice tool set for light needs in 1:1 calls (a quick
  `delegate` for calendar truth, or `task-create` when something must be parked
  right away), subject to the tool posture above;
- records **marks**: explicit "capture this" moments, appended to the transcript as
  flagged entries with a short spoken acknowledgement ("Noted"). A mark is a hint
  to the minutes writer, not a finished action.

The shim does **not** write minutes, track topic coverage with a tool, structure
decisions into typed actions, edit OKF workspaces, create recurring schedules or
send on other channels.

## Transcript

- **Day 1 (1:1 `conversational` calls):** every utterance already becomes a turn,
  and turn pairs are persisted to `working_memory` (`channel_id 'voice'`, user rows
  stamped with `sender_contact_id`). For these calls that is close enough to a
  transcript. **No schema change is needed.** Known gaps: utterances that were cut
  off or exceeded the size cap, and interim speech.
- **With `addressed_only` (Meet notetaker):** most utterances never become turns,
  so a dedicated store of timestamped, speaker-labelled segments is required. **That
  is a schema change and needs approval before it is built.** It moves into scope
  with #2231 Phase 1b, not before.

## Minutes

**Minutes** are a readable record of what was said and decided, written **after the
call** by a minutes writer on the standard tier. The writer takes:

- the agenda (title, topics, role, context);
- the transcript, with speaker attribution where available;
- the marks.

It produces prose, or lightly sectioned prose, that:

- records what was discussed and decided, topic by topic;
- says which agenda topics were covered, partly covered or not reached (coverage is
  worked out here, not tracked during the call);
- keeps open questions and "said they'd think about it" as spoken reality, not
  forced into false structure;
- **keeps attribution**: who said what and who committed to what. The structuring
  pass needs this to assign owners and apply trust.

The term "minutes" is intentional. It covers an agenda-driven conversation, a
passive notetaker, and any role in between, without renaming the artifact.

Minutes inherit the agenda's `sensitivity`.

## Deterministic handoff

The post-call pipeline is driven by **session end, not by the model calling a
tool**. Relying on the model would fail on a dropped call or a forgetful model.

```
voice.session.ended                    (exists; channel layer publishes)
  → system-layer subscriber
      → minutes writer (standard tier)
          → minutes.ready              (new; system layer publishes)
              → structuring task for the coordinator (agent.task)
```

- This follows established fan-out precedents: `conversation.checkpoint` →
  `extract-facts` (`src/checkpoint/processor.ts`) and `task.completed` →
  `deliverable-kg-promotion`. Agents never subscribe to bus events directly. The
  agent layer can only subscribe to `agent.task` and `tool.result`
  (`src/bus/permissions.ts`), so a system subscriber turns events into tasks.
- The `minutes.ready` payload carries **a reference, not the content**:
  `{ minutesRef, sessionId, conversationId, source, sensitivity }`. A consumer reads
  the minutes through a tool that does its own access check.
- Partial calls are handed off too. Unstructured notes beat a lost session.
- `async-offramp` keeps its current job: heavy requests made *during* the call. It
  is not the end-of-call path.
- The shim confirms that follow-up is underway only when the enqueue actually
  succeeded.

## Structuring pass: one owner

The **coordinator** owns structuring for every call source: 1:1s, onboarding,
board meetings, executive leadership team meetings, and ad-hoc calls.

Why one owner, not routing by source:

- **Consistency and testability.** One playbook, one eval surface. A group call can
  produce routines just as a 1:1 can, so splitting by source would split the same
  job across two prompts.
- **Tools.** Structuring can end in tasks, one-shot wake-ups, recurring schedules,
  document updates, preference changes or outbound follow-ups. The coordinator has
  `scheduler`, `documents` and the send skills; `meeting-debrief` does not.
- **The source changes the inputs, not the route.** Agenda, source, roster and
  sensitivity are all in the structuring task, so the same pass can treat a board
  meeting differently from an onboarding chat.

How it is delivered: the structuring instructions are a **lazy playbook** injected
when the structuring task fires, not new always-on coordinator prompt text (see
ADR-046). This keeps the coordinator's prompt budget intact.

The pass:

1. Interprets the minutes against the agenda and the context blob.
2. Produces **typed action items**: tasks (with owner `ceo`, `curia` or `external`
   taken from attribution), one-shot wake-ups, recurring schedules, document updates,
   config or preference changes, and outbound follow-ups.
3. Applies **per-speaker trust**. A consequential request from a non-principal
   speaker becomes a proposal for the principal, never something executed directly,
   because voice speaker identity can be spoofed. "Alex will send the deck" becomes
   an `external`-owned task, not a send by Curia.
4. **Provisioning is a separate, reviewable step.** Routines, schedules and other
   standing changes are proposed to the principal for confirmation. Low-risk
   captures (tasks, notes) can execute straight away. Optionally the coordinator can
   "start now" once the enqueue has succeeded.
5. Reports back on the agreed channel when something needs confirmation, or when the
   batch is done.

**Relationship to `meeting-debrief`.** For a calendar meeting that Curia attended,
the structuring pass *is* the debrief, so `meeting-debrief` must not also send its
blank "how did it go?" prompt for the same event. `meeting-debrief` keeps working
unchanged for meetings Curia did not attend. The deduplication mechanism is an open
question below. It only matters once Meet lands.

**Escape hatch.** If structuring load or prompt size becomes a problem for the
coordinator, it can move to a dedicated specialist without changing the contract
(`minutes.ready` → one structuring task, one owner).

## Sensitivity

Minutes contain other people's words and often confidential content, so sensitivity
is part of the contract from day one, even though only one consumer exists at
first:

- The agenda carries `sensitivity`: `internal` by default, `confidential` (board,
  leadership team) or `shareable`.
- Minutes inherit it, and `minutes.ready` carries it.
- Reading minutes goes through an access-checked tool. Wherever minutes are stored,
  a general-purpose read path (e.g. the OKF workspace that any agent with
  `documents` can search) must not bypass this.

## Future: event triggers for other agents

The deterministic handoff opens the door to other consumers of `minutes.ready`.
**This is not in the first slice.** It is recorded here because it shapes the event
design.

- The general mechanism would be a **declarative event trigger in agent YAML**,
  alongside the existing `schedule:` cron triggers. For example:
  `on_event: [{ event: minutes.ready, filter: …, task: "…" }]`. One system
  subscriber turns matching events into `agent.task`s. It also works for agents in
  the custom layer, which makes it a clean extension point for open-core operators.
- **Stress test: social media.** A social-media agent subscribes to `minutes.ready`
  to mine pithy, post-worthy insights. That forces the guardrails:
  - each trigger declares the maximum sensitivity it may receive. Social sees only
    `shareable` minutes (e.g. the principal's solo dictation calls), never
    `confidential` or `internal`;
  - payloads are references, and reads are access-checked;
  - anything public stays drafts-only, for the principal to review;
  - filters keep costs down, since every consumer is a model run per call.

## Transports

- **Console** (LiveKit): agenda via the session start.
- **Signal** (#1672): **inbound only**, because the bridge answers calls but never
  places them. Agendas reach an inbound call through a **pending agenda**. A routine
  or the coordinator parks an agenda for the principal, perhaps texting "got 5 min to
  go over X? call me". When the principal calls in, the bridge picks up the pending
  agenda if one exists and hasn't expired. Otherwise the call runs free-form, as
  today.
- **Google Meet** (#2231): Meet also provides a way for Curia to start calls. Curia
  books a Meet with the principal (or a group) and joins at the start time, which
  gives the onboarding ramp outbound calls without building outbound Signal
  calling. `addressed_only`, the roster, speaker attribution and the transcript
  store all arrive with Meet notetaker mode.

## First slice (dry-run over Signal)

Shippable value with no new transport and no migration:

1. **Agenda contract:** add `agenda?: VoiceAgenda` (`title`, `topics`, `role`,
   `context`, `source`, `sensitivity`) to `StartVoiceSessionParams`, render it as a
   block in `buildVoiceSystemPrompt`, and record the role text on the session.
2. **Pending agenda:** a way for the coordinator or a routine to park an agenda for
   the principal's next inbound call, with an expiry. The Signal bridge (and the
   console) pick it up at session start.
3. **Deterministic handoff:** a system subscriber on `voice.session.ended` runs the
   minutes writer over `working_memory` turns plus the agenda, then publishes
   `minutes.ready`.
4. **Structuring pass:** `minutes.ready` → coordinator structuring task with a lazy
   playbook → tasks executed, provisioning proposed, and a report back over Signal.

**Out of scope for the slice:** Meet, `turnPolicy`, roster and diarization, the
transcript table, `on_event` triggers, and the `meeting-debrief` deduplication.

## Onboarding example

A concrete use of the architecture is a **ramped onboarding voice sequence**:

- **What it is:** a series of short agenda-driven conversations covering
  preferences, identity, how the principal likes to communicate, and goals.
- **Cadence:** daily in week one, then weekly for about ninety days. The exact
  schedule is a product choice; the point is a planned ramp, not ad-hoc call spam.
- **Early sessions** mostly **capture**: minutes become preferences, profile entries
  and light tasks.
- **Later sessions** increasingly **provision**: the structuring pass proposes or
  adjusts routines and schedules so the office keeps working between calls.
- **How the calls happen:** with Signal, each session is a pending agenda plus a
  nudge to call in. With Meet, it is a booked recurring call that Curia joins.

Each session looks the same to the shim: agenda in, conversation, then transcript
out. The ramp lives in how agendas are authored and in what the structuring pass is
allowed to execute.

## Voice tool findings (current baseline)

Relevant facts from the current shim, so this design does not assume tools voice
does not have:

- Voice's fixed list (`VOICE_TOOL_NAMES`) is nine tools: `delegate`, `date-resolve`,
  `async-offramp`, `task-list`, `task-create`, `task-update`, `task-complete`,
  `memory-query`, `memory-store`.
- The four core **task** tools are present. The rest of the `tasks` bundle (`plan`,
  `checkpoint`) is not.
- The entire **`scheduler`** bundle is absent, so no routines can be created during
  a call.
- The **`documents`** bundle is absent. Voice also does not load pinned SKILL.md
  playbooks the way `assembleAgent` / `appendSkillInstructions` do for text agents.
- Sends, discovery (`tool-registry` / `skill-activate`) and autonomy approvals are
  deliberately excluded. Heavy or structured work is meant for `async-offramp` or
  `delegate`.
- Calendar truth during a call goes through `delegate` to `@calendar`, not through
  local calendar tools.

This design leans into that split: the shim's list stays small, and structuring and
provisioning happen in the post-call pass.

## Open questions

1. **Where minutes live.** The OKF document workspace is human-readable and needs no
   schema, but any agent with `documents` can search it, which conflicts with
   *Sensitivity*. The alternative is a small dedicated store with an access-checked
   read tool. Leaning: decide in the slice spec, with sensitivity as the deciding
   factor.
2. **Where pending agendas live.** One candidate is a task tagged `voice-agenda`,
   owned by Curia and waiting on the principal, with the agenda payload attached.
   This needs no schema change. The alternative is a dedicated store.
3. **How the principal reviews provisioning.** A Signal message listing proposed
   routines, a console review surface, or both.
4. **`meeting-debrief` deduplication (Meet only).** Does the debrief task check for
   minutes on the event, or does the structuring pass complete the debrief task?
5. **Cross-session memory.** How much should later agendas assume? A capped set of
   OKF onboarding sections, resolved upstream into the context blob, is a candidate.
   Caps and ownership are to be decided.
6. **Agenda authorship UX.** How much does a person edit, versus a routine template,
   versus the coordinator proposing the next call's agenda after the last
   structuring pass?

Resolved since the first draft:

- *Passive-listener mode* became `turnPolicy: addressed_only`, with role as free
  text.
- *Partial coverage* is handled: the transcript is persisted during the call, the
  handoff fires on session end, and partial minutes are always produced.

## Relationship to existing code

Anchors for a later implementation plan (not commitments in this doc):

- **Session start and prompt:** `src/channels/voice/voice-runtime.ts`
  (`StartVoiceSessionParams`, `buildVoiceSystemPrompt`).
- **Voice tool list:** `src/channels/voice/voice-tools.ts`.
- **Signal inbound calls:** `src/channels/voice/signal/signal-call-bridge.ts`.
- **Lifecycle events:** `voice.session.ended` in `src/bus/events.ts`; layer
  permissions in `src/bus/permissions.ts`.
- **Event → task fan-out precedent:** `src/checkpoint/processor.ts`,
  `src/agents/deliverable-kg-promotion.ts`.
- **Async handoff during a call:** `skills/async-offramp/`,
  `src/agents/prompts/voice-async-offramp.ts`.
- **Pin and playbook injection:** `src/startup/agent-assembly.ts`,
  `src/skills/pin-resolution.ts`. Behaviour-fix placement: ADR-046.
- **Tasks vs scheduler split:** `skills/tasks/`, `skills/scheduler/`, and the
  coordinator pins in `agents/coordinator.yaml`.
- **Meeting debriefs:** `agents/meeting-debrief.yaml`, spec 17.
- **Meet transport:** #2231.
