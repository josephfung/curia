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
- **Trigger:** Declarative cron in agent YAML config (`*/5 * * * *`)
- **Skills:** Calendar, email (draft + send), scheduler, KG/memory, `claim-conversation`, `debrief-status`, plus any future MCP tools. Can post Bullpen threads for cross-specialist work (see Section 6).
- **Persona:** Speaks as the coordinator's voice (all outbound messages go through OutboundGateway and maintain unified persona)

### Scheduler integration

```yaml
schedule:
  - cron: "*/5 * * * *"
    task: "Check for recently-ended meetings that may warrant follow-up"
    expectedDurationSeconds: 120
```

The scheduler publishes an `agent.task` event → meeting-debrief agent wakes up → checks calendar → either takes action or no-ops.

---

## 2. Detection Pipeline

Two-stage pipeline on each cron tick:

### Stage 1: Calendar scan (deterministic)

1. Call `calendar-list-events` for events ending in the window `[now - scanWindowMinutes, now]` (default 7 minutes, overlapping with 5-minute poll to handle drift)
2. Check scheduler task progress to skip meetings already handled:
   - `pendingDebriefs` map — meetings already prompted, awaiting CEO response
   - `judgedEvents` map — meetings already judged (YES, NO, or DEFER), keyed by calendar event ID with timestamp. Prevents re-evaluation on subsequent poll ticks.
3. Extract attendee emails, classify against `debrief.internalDomains` config
4. Pass candidates to Stage 2 with: title, description, duration, attendee list (with internal/external flags), recurrence pattern, and enriched entity context for known attendees

### Stage 2: LLM judgment (contextual)

For each candidate meeting, the agent's LLM decides: **does this meeting warrant follow-up?**

Context available:
- Meeting title, description, duration, recurrence
- Attendee names, emails, roles, org affiliations (from entity context enrichment)
- Internal vs. external classification per attendee
- KG facts about attendees — including debrief preferences (e.g., "CEO prefers no debrief prompts for meetings with this contact")
- General CEO preferences stored as KG facts on the CEO's entity

Judgment outputs:
- **YES** → proceed to prompt the CEO
- **NO** → skip. Record in `judgedEvents` with timestamp so it's not re-evaluated.
- **DEFER** → skip but record in `judgedEvents` as deferred. Also publish an `audit.event` so deferred meetings are visible in the audit log. The CEO can ask about deferred meetings via the `debrief-status` skill.

The LLM prompt will include guidance on what typically warrants follow-up (strategic discussions, partner meetings, board-adjacent, crisis comms) and what typically doesn't (personal appointments, routine recurring socials). But these are guidelines, not rules — the LLM makes the final call.

**TODO — Future work: Meeting artifact analysis.** When we know that certain meetings have artifacts (e.g., transcripts for recorded video meetings, note-keeping in a Google Drive folder, or updates to project management software), this agent should first analyze those artifacts to extract draft follow-up items before prompting the CEO. The prompt would then include: "Here's what I extracted from the meeting notes — anything to add or adjust?" This changes the interaction from open-ended to confirmatory, reducing friction. Out of scope for v1.

**TODO — Future work: Variable scan window.** The current `scanWindowMinutes` works for immediate prompting, but transcript-based workflows may need a different model: wait for the transcript to become available (which could take 10–30 minutes after a meeting ends), then process it, then prompt. This could be a per-meeting-type delay or a "wait for artifact readiness" mechanism. Out of scope for v1, but the scan window is configurable to accommodate initial experimentation.

---

## 3. State Management

**No bespoke database table** for follow-up state. All state uses existing Curia primitives.

### Ephemeral state → Scheduler task progress

The agent's `agent_tasks.progress` JSON field tracks:

```json
{
  "pendingDebriefs": {
    "nylas_event_abc": {
      "promptedAt": "2026-04-28T14:05:00Z",
      "conversationId": "signal:ceo:xyz",
      "reminderJobId": "job_123",
      "meetingTitle": "Strategy sync with Meridian",
      "attendees": ["sarah@meridian.com", "david@meridian.com"],
      "status": "awaiting_response"
    }
  },
  "judgedEvents": {
    "nylas_event_def": { "judgment": "no", "judgedAt": "2026-04-28T14:00:00Z" },
    "nylas_event_ghi": { "judgment": "defer", "judgedAt": "2026-04-28T14:00:00Z", "reason": "short internal standup, unclear if action-worthy" }
  },
  "lastScanTimestamp": "2026-04-28T14:00:00Z"
}
```

- `judgedEvents` entries pruned after `scanWindowMinutes + buffer` (e.g., 15 minutes) — they only need to survive until the event falls out of the scan window
- `pendingDebriefs` entries pruned after `claimTtlHours` (default 48 hours)
- **Before pruning expired entries**, the agent publishes an `audit.event` recording: meeting title, attendees, whether a prompt was sent, whether a response was received, and whether follow-up actions were taken. This ensures auditability even when state is cleaned up.

### Durable knowledge → KG facts (only when worth remembering)

- **Debrief preferences:** "CEO prefers no debrief prompts for meetings with Christophe" → fact on Christophe's contact KG node. Long-lived, inspectable, used by Stage 2 judgment.
- **Meeting outcomes:** "Agreed to deliver proposal to Meridian by May 15" → fact on Meridian org node or relevant contact nodes. Only stored when the follow-up produces substantive knowledge.
- **Completed follow-up summary:** When a follow-up is completed and has meaningful outcomes, a brief summary fact is stored on the relevant contact/org entities (e.g., "Follow-up from 2026-04-28 strategy sync: 3 actions taken — email drafted, meeting booked, commitment tracked"). This enables the CEO to ask "what follow-ups happened with Meridian recently?"
- **No KG entry** for: meetings skipped by judgment, meetings where CEO said "nothing", follow-up machinery state.

### Reminders → One-shot scheduler jobs

When a debrief prompt is sent, the agent creates a one-shot scheduler job:
- Fires after `debrief.reminderDelayMinutes` (default 120 minutes)
- Agent checks progress — if debrief is still pending, sends a brief nudge on the same conversation
- If debrief was already completed, the job no-ops

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

**Storage:** Dedicated `outbound_context` Postgres table with structured fields (agent_id, expected_reply, delegation_hint, metadata JSONB, expires_at, released flag). See `docs/wip/2026-05-16-context-bridging-v2-design.md` for full schema.

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

**Design spec:** `docs/wip/2026-05-16-context-bridging-v2-design.md` (issue #615)

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
1. Registers a conversation claim for the response thread (via `claim-conversation` skill)
2. Records the debrief in scheduler task progress (status: `awaiting_response`)
3. Creates a one-shot reminder job

---

## 6. Response Processing & Follow-Up Actions

When the CEO responds (routed via conversation claim), the agent processes the raw notes with full context.

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

The CEO can reply with corrections — the conversation claim keeps the thread routed to the meeting-debrief agent.

**Debrief completion:** When the CEO confirms or stops responding (claim expires), the agent:
1. Releases the conversation claim
2. Updates status in scheduler task progress to `completed` (with action summary)
3. Publishes an `audit.event` recording the debrief outcome
4. Stores any durable knowledge as KG facts (commitments, outcomes, preferences learned)
5. Stores a completed follow-up summary fact on relevant entities (enables "what follow-ups happened with X?" queries)
6. Prunes the entry from progress on the next cycle

---

## 7. Debrief Status Skill

**New skill:** `debrief-status`

A read-only skill available to the coordinator that queries the meeting-debrief agent's state. This enables the CEO to ask questions like:

- "What meetings from yesterday still need follow-up?"
- "What follow-ups are outstanding?"
- "Were there any meetings I missed giving takeaways for?"

**How it works:**
1. Reads the meeting-debrief agent's `agent_tasks.progress` JSON for pending and recently completed debriefs
2. For historical debriefs (beyond the progress TTL), queries KG facts for completed follow-up summaries on contact/org entities
3. Returns a structured summary the coordinator can relay to the CEO

This keeps the debrief state accessible without needing the coordinator to understand the meeting-debrief agent's internals.

---

## 8. Configuration

New top-level block in `config/default.yaml`:

```yaml
debrief:
  enabled: true
  channel: signal
  pollIntervalCron: "*/5 * * * *"
  internalDomains:
    - josephfung.ca
  reminderDelayMinutes: 120
  scanWindowMinutes: 7
  claimTtlHours: 48
```

All values have sensible defaults. The LLM judgment handles nuance — config handles mechanics.

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
- Detection pipeline: mock calendar responses, verify internal/external classification, verify dedup against progress (both `pendingDebriefs` and `judgedEvents`)
- Conversation claim registry: claim lifecycle (create, check, expire, release), fallback routing, survives simulated restart
- State management: progress JSON operations, pruning logic, audit event publication on prune
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
| `agents/meeting-debrief.yaml` | Agent config: prompt, skills, schedule (no outbound skills pinned) |
| `skills/debrief-status/` | Skill for coordinator to query debrief state |
| Config additions to `config/default.yaml` | `debrief:` top-level block |

**Prerequisite infrastructure (delivered by #615 — context bridging v2):**

| File | Purpose |
|---|---|
| `src/db/migrations/NNN_create_outbound_context.sql` | Dedicated table for context bridge entries |
| `src/dispatch/outbound-context.ts` | Service class: write, query active, release |
| `skills/context-bridge-release/` | Coordinator skill to mark entries as released |
| Updates to `skills/signal-send/`, `skills/email-send/` | Accept optional `context_bridge` param |
| Update to `src/dispatch/dispatcher.ts` | Read path queries new table for injection |
| Update to `agents/coordinator.yaml` | Delegation guidance for active context entries |

---

## Implementation Status

| Number | Item | Status |
|---|---|---|
| 0 | Proactive outbound Signal from scheduled jobs (#374) — prerequisite | Done |
| 1 | Context bridging v2 (#615) — prerequisite infrastructure | Done |
| 2 | `debrief:` config block in `config/default.yaml` + startup validation | Done |
| 3 | `meeting-debrief` agent YAML config (prompt, skills, schedule) | Done |
| 4 | Detection pipeline — calendar scan, prompt-driven classification via LLM judgment | Done |
| 5 | LLM judgment — contextual YES/NO/DEFER assessment in agent system prompt | Done |
| 6 | Prompt delivery — Bullpen request to coordinator, context bridge registered | Done |
| 7 | Reminder check — cron-tick timestamp check on pendingDebriefs (not one-shot jobs) | Done |
| 8 | Response processing — coordinator delegates reply, agent executes follow-ups | Done |
| 9 | Cross-specialist work via Bullpen — research delegation pattern | Done |
| 10 | State persistence — `scheduler-report` context between cron runs | Done |
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
