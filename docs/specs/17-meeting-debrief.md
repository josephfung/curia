# Spec 17: Meeting Debrief

## Context

After meetings — particularly those involving external participants, but sometimes key internal meetings too — the CEO wants Curia to proactively prompt for takeaways via a chat channel (Signal today, channel-agnostic by design). Based on the CEO's raw notes, Curia then executes follow-up actions: drafting emails, booking meetings, tracking commitments, doing research, or anything else within its skill set.

This is Curia's first **proactive agent flow**: a specialist agent that initiates conversations rather than responding to them. It requires a new architectural primitive — **conversation claims** — that enables any agent to own a user-facing conversation thread.

The feature has two distinct phases per meeting:
1. **Debrief prompt** — Curia asks the CEO for takeaways (the trigger)
2. **Follow-up actions** — Curia executes whatever the CEO's notes imply (the value)

---

## 1. Meeting-Debrief Agent

**New file:** `agents/meeting-debrief.yaml`

A specialist agent triggered by a scheduler cron job. It owns the full meeting follow-up lifecycle: detect → judge → prompt → process response → execute follow-up actions.

- **Role:** `specialist`
- **Trigger:** Declarative cron in agent YAML config (`0 7,12,16 * * *`)
- **Skills:** Calendar, email (draft + send), scheduler, KG/memory, `claim-conversation`, `debrief-status`, plus any future MCP tools. Can post Bullpen threads for cross-specialist work (see Section 6).
- **Persona:** Speaks as the coordinator's voice (all outbound messages go through OutboundGateway and maintain unified persona)

### Scheduler integration

```yaml
schedule:
  - cron: "0 7,12,16 * * *"
    task: "Scan upcoming meetings for the rest of the day and pre-schedule debrief tasks"
    expectedDurationSeconds: 120
```

The scheduler publishes an `agent.task` event → meeting-debrief agent wakes up → scans the calendar forward for the rest of the day → schedules a debrief task per qualifying meeting → no-ops if nothing qualifies.

---

## 2. Detection Pipeline

Two-stage pipeline on each detection run (3x/day at `0 7,12,16`):

### Stage 1: Calendar scan (deterministic)

1. Call `calendar-list-events` for events scheduled between now and end-of-day (forward scan, not backward)
2. Skip events already seen: check `config-store` for a `seen:<eventId>` key (set by previous detection runs for both YES and NO judgments)
3. Extract attendee context (names, roles, org affiliations via entity context enrichment) and recurrence pattern
4. Pass candidates to Stage 2 with: title, description, duration, attendee list, recurrence pattern, and enriched entity context for known attendees

### Stage 2: LLM judgment (contextual)

For each candidate meeting, the agent's LLM decides: **does this meeting warrant follow-up?**

Context available:
- Meeting title, description, duration, recurrence
- Attendee names, emails, roles, org affiliations (from entity context enrichment)
- KG facts about attendees — including debrief preferences (e.g., "CEO prefers no debrief prompts for meetings with this contact")
- General CEO preferences stored as KG facts on the CEO's entity

Judgment outputs:
- **YES** → schedule a debrief task (see §3) and write `seen:<eventId>` to `config-store`
- **NO** → write `seen:<eventId>` to `config-store` only; no task created. On a genuine fence, the judgment leans YES.

There is no DEFER outcome. The LLM prompt will include guidance on what typically warrants follow-up (strategic discussions, partner meetings, board-adjacent, crisis comms) and what typically doesn't (personal appointments, routine recurring socials). But these are guidelines, not rules — the LLM makes the final call.

The accepted trade-off of 3x/day scanning: a meeting added *and* occurring entirely inside a scan gap will be missed. Cancellations and reschedules of already-seen meetings are caught at the prompt wake by re-validating the event at that point.

**TODO — Future work: Meeting artifact analysis.** When we know that certain meetings have artifacts (e.g., transcripts for recorded video meetings, note-keeping in a Google Drive folder, or updates to project management software), this agent should first analyze those artifacts to extract draft follow-up items before prompting the CEO. The prompt would then include: "Here's what I extracted from the meeting notes — anything to add or adjust?" This changes the interaction from open-ended to confirmatory, reducing friction. Out of scope for v1.

---

## 3. State Management

**No bespoke state maps.** Debrief work is tracked as platform **tasks**
([spec 19 — Tasks & Backlog](19-tasks-and-backlog.md)), not the former
`pendingDebriefs` / `judgedEvents` / `deferredEvents` maps in scheduler progress.

### Debrief tasks

Each meeting that warrants a debrief is one task:
- `tag = ['debrief-pending']`, `title = "Debrief: <meeting>"`.
- `owner` starts `'curia'` (Curia owes the prompt) and flips to `'ceo'` at the
  prompt wake (the CEO then owes takeaways). This drives the digest's three-way
  grouping: a scheduled-but-unprompted debrief shows under "What I'm working on";
  once prompted it moves to "For you to do".
- `intent_anchor` carries the calendar `eventId` and the meeting's scheduled end.
  It is delivered to the agent on each wake-up (system-prompt injection) but is
  not returned by `task-list`, so it stays out of the CEO's digest.
- The lifecycle is a chain of `wake_at` re-schedules on the one task row:
  `meeting end → deliver prompt` → `+reminderDelay → one reminder` →
  `+TTL → expire (cancel)`. A CEO reply completes the task early and auto-cancels
  the pending wake-up.

Follow-up actions discovered from a CEO reply become **child tasks**
(`parent_task_id` = the debrief task, `tag = ['debrief-followup']`): work Curia
does inline is recorded as a completed child; a call only the CEO can make is an
open `owner='ceo'` child; third-party-blocked work is an open `owner='external'`
child.

### Detection cadence

Detection runs **3×/day** (`0 7,12,16`), scanning the rest of the day forward
and scheduling a debrief task per qualifying meeting. Judgment is binary
**YES/NO** (no DEFER); on a genuine fence it leans YES. A not-worthy meeting
creates **no task** — only a `seen:` guard (below). The accepted trade-off is
that a meeting added *and* occurring entirely inside a scan gap is missed;
cancellations/reschedules of known meetings are caught by re-validating the
event at the prompt wake.

### Phase guards via `config-store` (namespace `"debrief"`)

Three keys, all CEO-invisible; the lifecycle phase is derived from them rather
than stored as data:

- `seen:<eventId>` — detection dedup; set for every judged event (YES and NO).
- `prompted:<eventId>` — set when the prompt is sent (also the layer-2 duplicate
  guard, below). Absent at a wake ⇒ scheduled phase; present ⇒ prompted.
- `reminded:<eventId>` — set when the one reminder is sent. With `prompted:`
  present: absent ⇒ reminder phase; present ⇒ expiry phase.

#### Cross-tick idempotency via `config-store`

The `prompted:<eventId>` key is the agent's layer-2 "have I prompted for this
meeting?" guard, independent of the task representation: before posting a Bullpen
debrief prompt the agent checks it, and after a successful post it writes the key
(with the thread ID). Even if a future regression resends a wake or re-creates a
task, this guard prevents a duplicate user-facing prompt. It is the same
defense-in-depth that originally fixed the #724 duplicate-prompt incident.

### Durable knowledge → KG facts (only when worth remembering)

- **Debrief preferences:** "CEO prefers no debrief prompts for meetings with
  Christophe" → fact on Christophe's contact KG node. Used by judgment.
- **Meeting outcomes / completed follow-ups:** stored on the relevant contact/org
  entities only when the follow-up produced substantive knowledge.
- **No KG entry** for: meetings skipped by judgment, "nothing needed" replies, or
  task machinery state.

---

## 4. Reply Routing via Context Bridging v2

### The problem

When the meeting-debrief agent sends a prompt via Signal, the CEO's response arrives as an `inbound.message`. The coordinator receives all inbound messages but has no context about which specialist sent the prompt or what kind of reply to expect.

### The solution: Bullpen-through-coordinator + enhanced context bridging

**Architectural principle:** The coordinator is the sole voice for all human-facing communication. Specialist agents never call outbound skills directly. When a specialist needs to send a proactive message, it requests the send via a Bullpen thread mentioning the coordinator.

**Outbound flow (Bullpen-through-coordinator):**
1. Meeting-debrief agent detects a meeting that warrants follow-up
2. Agent posts a Bullpen thread mentioning the coordinator with: the message to send, channel, and context bridge metadata (originating agent, expected reply type, delegation hint, expiry)
3. Coordinator receives via Bullpen task, applies judgment (timing, persona, relevance)
4. Coordinator calls `signal-send` with `context_bridge` parameters
5. Context bridge entry is written atomically with the send

**Inbound flow (delegation via context bridge):**
1. CEO responds on Signal (or any channel)
2. Dispatcher routes to coordinator (always — no routing bypass)
3. Coordinator sees `[ACTIVE OUTBOUND CONTEXT]` block injected by dispatcher
4. Coordinator judges relevance — if reply relates to an active entry, delegates to the hinted specialist via the existing `delegate` skill
5. Specialist processes and returns result; coordinator relays in its own voice

**Storage:** Dedicated `outbound_context` Postgres table with structured fields (agent_id, expected_reply, delegation_hint, metadata JSONB, expires_at, released flag). See [spec 11 — Outbound Context Bridge](11-entity-context-enrichment.md#outbound-context-bridge) for the schema, lifecycle, and capability surface. The architectural decision is recorded in [ADR-019](../adr/019-delegation-aware-outbound-context.md).

**Lifecycle:**
- **Created** atomically with the outbound send (via `context_bridge` param on send skills)
- **Expires** after configurable TTL (default 48 hours)
- **Released** explicitly by the coordinator (via `context-bridge-release` skill) when conversation completes
- **Read** by the dispatcher on every inbound — all active entries injected into coordinator's task

**Security properties preserved:**
- Coordinator sees and approves all outbound before it's sent
- Coordinator receives all inbound and applies judgment before delegating
- No dispatcher routing bypass — coordinator is always the entry point
- Skill registry enforcement: specialist agents do not have outbound communication skills pinned

**Design spec:** [spec 11 §Outbound Context Bridge](11-entity-context-enrichment.md#outbound-context-bridge) + [ADR-019](../adr/019-delegation-aware-outbound-context.md) (issue #615)

---

## 5. Prompt Delivery

When a meeting passes both detection stages, the agent sends a conversational prompt via the CEO's configured channel.

**Channel-agnostic design:** The agent targets `debrief.channel` from config (e.g., `signal`). It uses the OutboundGateway with the appropriate channel ID. Changing the config value to `email` or a future channel like `slack` requires zero code changes.

**Message style — conversational, brief, efficient:**

> "You just wrapped up with Sarah Chen and David Park from Meridian. Any takeaways or follow-ups?"

The prompt is:
- Conversational, not formal — brief and efficient since the CEO is likely running to the next task
- Names the attendees (enriched from contacts/KG)
- Open-ended — doesn't assume what kind of follow-up is needed
- Short — one or two sentences max

After sending, the agent:
1. Writes the `prompted:<eventId>` guard to `config-store` (namespace `"debrief"`) with the Bullpen thread_id and timestamp
2. Flips the debrief task to `owner: "ceo"` and schedules the reminder via `wake_at` (task-update)

> **Note (tasks migration, #839):** The earlier design used `claim-conversation` + scheduler-report task progress here. These are superseded — see the Historical appendix.

---

## 6. Response Processing & Follow-Up Actions

When the CEO responds (routed via context bridge delegation to meeting-debrief), the agent processes the raw notes with full context.

**Context available:**
- The meeting that triggered the prompt (title, attendees, duration)
- Entity-enriched attendee profiles (roles, org affiliations, KG facts, preferences)
- The CEO's raw notes/takeaways

**Action execution:** No fixed categories or classifier. The agent's LLM reads the notes in context and uses its full skill set to execute whatever follow-up actions are implied. Examples:

- "Send Sarah the proposal" → `email-draft-save` (draft-first default)
- "Set up a follow-up next week" → `calendar-check-conflicts` + `calendar-create-event`
- "We committed to May 15 delivery" → KG fact on relevant entities
- "Book me a flight to Toronto for the on-site" → uses whatever travel skill/MCP is available (fails gracefully if none exists, reports back what it couldn't do)
- "Nothing, just a check-in" → marks debrief complete, no actions

**Cross-specialist work via Bullpen:** For actions that require other specialist agents (e.g., "look into their competitor landscape" → needs the research-analyst), the meeting-debrief agent posts a Bullpen discussion thread mentioning the research-analyst: "Need competitor landscape research for Meridian. Context: [meeting summary]." The BullpenDispatcher delivers this as an `agent.task` (reply-expected) to the research-analyst. The coordinator can observe the thread but doesn't need to be the bottleneck. Results come back in the Bullpen thread, and the meeting-debrief agent incorporates them into its follow-up summary to the CEO. This uses the existing inter-agent collaboration pattern rather than routing everything through the coordinator.

**Draft-first default:** All emails are saved as drafts unless the CEO explicitly says "send" or "reply now." Outbound content filter still applies regardless.

**Confirmation message:** After processing, the agent summarizes what it's doing on the same thread:

> "On it:
> 1. Drafting follow-up email to Sarah with the proposal (check your drafts)
> 2. Finding a 30-min slot with Meridian next week
> 3. Noted: delivery commitment to Meridian by May 15
> 4. Kicked off research on Meridian's competitor landscape — I'll send findings when ready
> Anything to adjust?"

The CEO can reply with corrections — the context bridge delegation keeps the thread routed to the meeting-debrief agent.

**Debrief completion:** When the CEO confirms (or the debrief expires without a response), the agent:
1. Calls `task-complete` on the debrief task (auto-cancels any pending reminder/expiry wake)
2. Stores any durable knowledge as KG facts (commitments, outcomes, preferences learned) on relevant contact/org entities

> **Note (tasks migration, #839):** The earlier design released a conversation claim and updated scheduler-report progress here. These are superseded — see the Historical appendix.

---

## 7. Debrief Status Queries

> **Superseded by tasks migration (#839).** No separate `debrief-status` skill was built. The coordinator handles status queries ("What meetings still need debrief?") by delegating directly to the meeting-debrief agent, which reads its own open tasks via `task-list` (tag: `debrief-pending`). This is consistent with the general specialist-delegation pattern. See the Historical appendix for the original `debrief-status` skill design.

---

## 8. Configuration

Runtime settings are stored in `config-store` under namespace `"debrief"`, key `"config"`. The agent reads them on every run with `action: "retrieve"`. Defaults apply if the key is not found:

```yaml
# config-store namespace "debrief", key "config" (stored as JSON)
channel: signal                 # channel for debrief prompts
reminderDelayMinutes: 120       # minutes after prompt before sending reminder
contextBridgeTtlHours: 48       # TTL for context bridge entries and debrief expiry window
```

The detection cron (`0 7,12,16 * * *`) is declared in the agent YAML `schedule` block, not in config. `internalDomains`, `scanWindowMinutes`, `detectionCron`, and `claimTtlHours` are removed — the forward-scan window is end-of-day and attendee classification uses LLM judgment from KG-enriched context.

**Note — separate issue:** The `research-analyst` agent currently has no `enabled` config option in its YAML. All specialist agents should have an enable/disable toggle. This is a pre-existing gap, not specific to this feature, but worth tracking as a follow-up.

---

## 9. Follow-Up Issues

These are out of scope for this feature but identified during design:

1. **Research analyst multi-turn conversations** — Enable the research-analyst agent to leverage conversation claims for iterative, multi-turn research tasks where the CEO and agent go back and forth. Today it's one-shot delegation only.

2. **Calendar channel as event emitter (Approach C)** — Future enhancement: transform the calendar channel from passive observer to active event source (emitting `calendar.meeting_ended` events). Would make the debrief trigger more responsive and benefit other calendar-driven features. Not needed for initial implementation (polling works fine).

3. **Meeting artifact analysis** — Before prompting the CEO, check for meeting artifacts (transcripts, shared notes, PM tool updates) and pre-populate follow-up suggestions. Changes the interaction from open-ended to confirmatory.

4. **Variable scan window / artifact readiness** — For meetings with transcripts, the agent may need to wait for the transcript to become available (10–30 minutes) before processing. Requires a "wait for artifact" mechanism beyond a simple scan window.

5. **Agent enable/disable config** — All specialist agents (including research-analyst) should have an `enabled: true/false` toggle in their YAML config, checked at startup.

6. **Debrief analytics** — Track which meetings generate the most valuable debriefs, which action types are most common, and whether the LLM judgment accuracy improves over time.

---

## 10. Verification Plan

### Unit tests
- Detection pipeline: mock calendar responses, verify dedup via `seen:<eventId>` config-store key, verify YES schedules a task and NO creates only the seen guard
- Conversation claim registry: claim lifecycle (create, check, expire, release), fallback routing, survives simulated restart
- State management: task lifecycle (create, owner flip, child tasks, cancel on reply), config-store phase guard reads/writes
- `debrief-status` skill: reads progress correctly, reports pending and completed

### Integration tests
- End-to-end: scheduler fires → agent detects meeting → sends prompt → claim registered → response routed → actions executed → claim released
- Reminder flow: prompt sent → no response → reminder fires → nudge sent
- Preference learning: CEO says "no debriefs for meetings with X" → stored as KG fact → next meeting with X is skipped by judgment
- Cross-specialist via Bullpen: CEO asks for research → agent posts Bullpen thread mentioning research-analyst → research-analyst processes and replies → agent incorporates results
- Queryability: CEO asks "what meetings still need debrief?" → coordinator calls `debrief-status` → correct results

### Smoke tests
- Add to existing smoke test framework (GPT-4o judge, HTML reports)
- Scenario: "A meeting with external attendees just ended. Does the agent prompt for a debrief?"
- Scenario: "CEO provides takeaways. Does the agent execute reasonable follow-up actions?"
- Scenario: "CEO asks what meetings need debrief. Does the status skill return useful info?"

### Manual testing
- Run with real calendar data and Signal channel
- Verify the prompt message is conversational, brief, and correctly names attendees
- Verify draft emails appear in email drafts
- Verify calendar events are created in the right time slots
- Verify KG facts are stored correctly for commitments and preferences
- Verify claims survive a server restart

---

## 11. New Files Summary

| File | Purpose |
|---|---|
| `agents/meeting-debrief.yaml` | Agent config: prompt, skills, 3×/day schedule |
| `config-store` namespace `"debrief"`, key `"config"` | Runtime operator settings (channel, reminder delay, TTL) |

**Prerequisite infrastructure (delivered by #615 — context bridging v2; see [spec 11 §Outbound Context Bridge](11-entity-context-enrichment.md#outbound-context-bridge)):**

| File | Purpose |
|---|---|
| `src/db/migrations/042_create_outbound_context.sql` | Dedicated table for context bridge entries |
| `src/dispatch/outbound-context.ts` | `OutboundContextService` + `ScopedOutboundContext`: register, query active, release, cleanup |
| `skills/context-bridge-release/` | Coordinator-only skill to mark entries as released |
| `src/dispatch/context-bridge-parse.ts` | Shared helper module to normalize `context_bridge` JSON inputs |
| Updates to `skills/signal-send/`, `skills/email-send/`, `skills/email-reply/` | Unconditional registration on success; honor optional `context_bridge` param |
| Update to `src/dispatch/dispatcher.ts` | Read path queries `outbound_context` for `[ACTIVE OUTBOUND CONTEXT]` injection |
| Update to `agents/coordinator.yaml` | Delegation-hint guidance for outbound context entries |

---

## Implementation Status

> **Note:** Sections 1–10 were updated to reflect the current implementation
> (tasks migration, #839). Superseded content has been moved to the Historical
> appendix at the bottom of this document. The implementation (agent YAML,
> config, tests) is authoritative; this spec tracks its normative contract.

| Number | Item | Status |
|---|---|---|
| 0 | Proactive outbound Signal from scheduled jobs (#374) — prerequisite | Done |
| 1 | Context bridging v2 (#615) — prerequisite infrastructure | Done |
| 2 | `debrief:` config block in `config/default.yaml` + startup validation | Done |
| 3 | `meeting-debrief` agent YAML config (prompt, skills, schedule) | Done |
| 4 | Detection pipeline — calendar scan, prompt-driven classification via LLM judgment | Done |
| 5 | LLM judgment — binary YES/NO in agent system prompt (DEFER removed) | Done |
| 6 | Prompt delivery — Bullpen request to coordinator, context bridge registered | Done |
| 7 | Reminder check — single reminder via wake_at re-schedule on debrief task | Done |
| 8 | Response processing — coordinator delegates reply, agent executes follow-ups | Done |
| 9 | Cross-specialist work via Bullpen — research delegation pattern | Done |
| 10 | State persistence — platform tasks + config-store phase guards (replaces scheduler-report maps) | Done |
| 11 | Status queries — coordinator delegates to meeting-debrief (no separate skill) | Done |
| 12 | Preference learning — store CEO feedback as KG facts, wire into judgment | Done |
| 13 | Audit events — state transitions, expired entry pruning | Done |
| 14 | Unit tests — config validation | Done |
| 15 | Integration tests — end-to-end Bullpen→coordinator→send→reply→delegate flows | Not Done |
| 16 | Smoke tests — LLM judge scenarios for debrief detection and actions | Not Done |

**Design notes (2026-05-25):**
- Items 4–13 are implemented as prompt-driven logic in the agent's system prompt, not custom handler code — consistent with the ceo-inbox pattern.
- Item 7 revised: reminders are checked on each cron tick by scanning pendingDebriefs timestamps, not via one-shot scheduler jobs. Simpler, all state stays in scheduler-report context.
- Item 11 revised: no separate `debrief-status` skill. The coordinator delegates status queries to meeting-debrief directly (consistent with specialist delegation pattern). Agent reads its own state via `scheduler-list`.
- Internal/external classification dropped `internalDomains` config — the LLM judges meeting worthiness from attendee context (KG enrichment) rather than rigid domain matching.
- Integration and smoke tests deferred to follow-up — the feature is prompt-driven so the primary verification is manual smoke testing on a live deployment.

**Design notes (2026-06-04 — tasks migration, #839):**
- §3 rewritten: state moves from `pendingDebriefs`/`judgedEvents`/`deferredEvents` maps in scheduler progress to platform tasks (`debrief-pending` tag) with child tasks for follow-up actions. Config-store phase guards (`seen:`, `prompted:`, `reminded:`) replace the old map entries.
- Detection cadence changed from `*/5 * * * *` (reactive, backward scan) to `0 7,12,16 * * *` (3×/day, forward scan to end-of-day).
- Judgment simplified to binary YES/NO; DEFER outcome removed.
- `scanWindowMinutes` config key removed; forward scan window is always end-of-day.
- Item 7 updated: reminder is now the second `wake_at` re-schedule on the debrief task row, not a cron-tick scan of in-memory state.
- Sections 5, 6, 7, 8, 11 updated to reflect current implementation. Superseded content in Historical appendix below.

---

## Appendix: Historical Design (Pre-Tasks Migration)

> The following content describes the original design that was **superseded by the tasks migration (#839, 2026-06-04)**. It is preserved here for context only — the agent YAML and §3 state management section above describe the current authoritative contract.

### Historical §5 — After sending

In the original design, after sending the debrief prompt the agent:
1. Registered a conversation claim for the response thread (via `claim-conversation` skill)
2. Recorded the debrief in `agent_tasks.progress` JSON (status: `awaiting_response`)
3. Created a one-shot reminder job via the scheduler

These steps were replaced by: writing the `prompted:<eventId>` config-store guard + updating the debrief task (`owner: "ceo"`, `wake_at: +reminderDelayMinutes`).

### Historical §6 — Debrief completion

In the original design, debrief completion:
1. Released the conversation claim (`context-bridge-release`)
2. Updated scheduler task progress to `completed`
3. Published an `audit.event`
4. Stored KG facts
5. Stored a completed follow-up summary fact on relevant entities
6. Pruned the entry from progress on the next cycle

These steps were replaced by: `task-complete` on the debrief task (which auto-cancels the pending wake) plus targeted KG fact storage.

### Historical §7 — Debrief Status Skill

The original design called for a `debrief-status` skill (read-only, coordinator-pinned) that read `agent_tasks.progress` JSON for pending debriefs and KG facts for historical debriefs.

**Superseded:** No separate skill was built. The coordinator delegates status queries directly to meeting-debrief, which reads its own open tasks via `task-list`.

### Historical §8 — Configuration

The original config block in `config/default.yaml`:

```yaml
debrief:
  enabled: true
  channel: signal
  detectionCron: "0 7,12,16 * * *"
  reminderDelayMinutes: 120
  claimTtlHours: 48
```

**Superseded:** Runtime settings are now stored in `config-store` (namespace `"debrief"`, key `"config"`). `detectionCron` moved to the agent YAML `schedule` block. `claimTtlHours` renamed to `contextBridgeTtlHours` to match the context bridge TTL semantics.
