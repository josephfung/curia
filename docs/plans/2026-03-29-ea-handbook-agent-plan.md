# Agent & Skill Plan: EA Handbook Analysis

**Date:** 2026-03-29
**Status:** Proposed
**Source:** _The Executive Assistant Handbook: Your CEO's Life, Organized_ by Stephanie Martin (v1.0, July 2025)

## Background

Stephanie Martin's EA Handbook is a 56-page practical guide for Executive Assistants,
covering calendar management, email triage, meeting coordination, travel logistics, board
prep, executive profiling, confidentiality, and proactive ops. It was written from years of
real-world experience supporting CEOs.

This plan maps the handbook's actionable domains to candidate Curia agents and skills,
assessing feasibility, constraints, and build effort for each.

## Methodology

Every section of the handbook was evaluated against three questions:

1. **Can Curia do this?** Does the task fit within Curia's architecture (message bus,
   agents, skills, channels, knowledge graph)?
2. **Where will Curia excel?** Tasks where software has structural advantages over
   a human EA (consistency, availability, parallel processing, perfect recall).
3. **Where is Curia constrained or infeasible?** Tasks requiring physical presence,
   social nuance, or APIs that don't exist.

### Design Principle: Skills Must Add Value Beyond the Bare LLM

Curia's agents are powered by LLMs. An LLM can already write emails, summarize threads,
classify urgency, and generate briefings. A skill that merely wraps what the LLM does
natively is a **downgrade** — it replaces flexible, context-aware generation with rigid
code that the LLM could outperform on its own.

Every skill must pass this test: **"What does this skill do that the LLM cannot do
(or should not be trusted to do) by itself?"**

Skills add genuine value when they provide:

- **API access** — the LLM cannot call Google Calendar, Nylas, or Slack without a tool.
  These skills are always justified.
- **Deterministic data storage/retrieval** — loyalty numbers, meeting links, and company
  facts must be stored and recalled exactly, not paraphrased. The knowledge graph is the
  right home for these, and skills are the right interface.
- **Organizational policy & guardrails** — instead of rigid templates, skills should store
  and retrieve *guidelines* (required elements, tone constraints, structural rules) that
  the LLM follows when composing. The skill enforces consistency; the LLM provides
  fluency and adaptation.
- **Data aggregation & orchestration** — gathering data from multiple sources (calendar +
  contacts + email) into a structured package is plumbing the LLM shouldn't be doing
  turn-by-turn. Briefing skills justify their existence by assembling, not by writing.
- **Scheduled/autonomous execution** — cron-triggered proactive checks can't rely on
  a user prompt to initiate. Skills provide the entry point and structured evaluation.

Skills that fail this test should be **removed or redesigned**:

- A skill that does string interpolation on a template is a downgrade from the LLM
  composing the same email natively. **Redesign**: store guidelines + example, return them
  as instructions for the LLM to compose from.
- A skill that "classifies urgency" by running hardcoded rules is worse than the LLM's
  judgment. **Redesign**: the skill applies labels via API; the LLM decides the label.
- A skill that "summarizes a thread" is literally what the LLM already does. **Remove**
  as a standalone skill — the LLM does this in-context. Only justify it if it runs as a
  background batch job where the LLM isn't already in the conversation.

### Design Principle: Future-Proof for LLM Upgrades

Skills should be designed so that improvements in the underlying LLM automatically
improve the system — without code changes. This means:

**Skills provide data, context, and constraints — never intelligence.**

1. **Richer context → better output.** As LLMs become better at utilizing large contexts,
   skills that assemble more relevant context (contact history, preferences, past
   interactions, audience-specific patterns) will produce proportionally better results.
   Design skills to gather and surface *more* context than the current LLM can fully
   exploit — the next model will use it.

2. **Better instruction following → policies become more valuable.** Structured guidelines
   (required elements, tone, constraints) work better with each model generation. Invest
   in policy richness — audience-level variants, conditional rules, voice model
   integration — because the LLM's ability to follow them faithfully will only improve.

3. **Better multi-step reasoning → composable primitives.** As LLMs improve at tool
   orchestration, small, composable skills become more powerful than monolithic ones.
   Design skills as primitives that the LLM chains together, not as pre-wired workflows
   the LLM merely triggers.

4. **Never embed intelligence in skill code.** If the skill contains `if/else` logic that
   makes a judgment call (classifying, prioritizing, summarizing, deciding), that logic
   will be *worse* than the LLM at the time of writing and will fall further behind as
   models improve. Move judgments to the agent's prompt; keep skills as data plumbing.

5. **Design for feedback loops.** Static skills improve only when a developer ships a code
   change. Skills that accept natural-language refinement ("make these more casual",
   "always include my assistant's availability") improve continuously from user
   interaction. Every skill that stores policy or preferences should support incremental
   refinement, not just wholesale replacement.

These principles apply to all future agent and skill development, not just the skills
in this plan.

### Design Principle: Skills Must Compose

A skill that operates in isolation forces the LLM to orchestrate multiple tool calls to
assemble context. This wastes turns, burns tokens, and creates fragile multi-step
sequences where any failure breaks the chain.

**Context assembly skills** bridge this gap. Given a task context (e.g., "I'm writing a
meeting request to Alice"), a context assembly skill gathers everything relevant in a
single call: email policy + contact info + meeting link + audience preferences + last
interaction. The LLM gets complete context in one response, composes in the next.

Rules for composability:
- Knowledge skills should be callable by other skills (via shared EntityMemory access)
- Context assembly skills should aggregate across knowledge skills, contacts, and KG
- No skill should require the output of another skill as a *string* input — use shared
  backing stores (KG, contact service) instead

---

## Proposed Agents

### 1. Calendar Agent — `core`

Owns all Google Calendar operations. Reads and writes events, enforces formatting
conventions, manages color coding, timezone handling.

| Skill | What it does |
|---|---|
| `calendar.list-events` | Fetch events for a date range, return structured data |
| `calendar.create-event` | Create event with proper title format, color, Zoom link, context, timezone |
| `calendar.update-event` | Modify existing events (time, attendees, description) |
| `calendar.delete-event` | Cancel/remove events |
| `calendar.find-free-time` | Query availability windows across calendars |
| `calendar.check-conflicts` | Detect double-bookings or tight overlaps |
| `calendar.color-code` | Apply color coding rules from CEO preferences |
| `calendar.add-travel-block` | Insert transit blocks before/after in-person events |
| `calendar.add-focus-time` | Block focus/deep-work time on specified days |

**Handbook coverage:** Calendar Management, Meeting Booking Notes, Calendar Hygiene,
Meeting Setup & Defaults, In-Person Events, Focus Time, Travel time blocks

**Dependencies:** Google Calendar API OAuth integration (server-side, not the Claude Code
MCP)

**Value justification:** Every skill here is an API bridge — the LLM cannot read or write
calendar data without these tools. Pure infrastructure. No design risk.

---

### 2. Email Triage Agent — `core` (basic) / `paid` (advanced)

Processes inbound email, classifies by urgency/type, extracts action items, applies
labels, surfaces what needs CEO attention. Works on top of the existing email channel.

Basic skills (`classify`, `label`, `surface-urgent`, `archive-resolved`) are in the
open source core. Advanced skills (`extract-actions`, `summarize-thread`) are paid tier.

| Skill | What it does |
|---|---|
| Skill | What it does |
|---|---|
| `email.label` | Apply triage labels to messages via Nylas API (maps to handbook's label system) |
| `email.surface-urgent` | Push urgent items to CEO via CLI notification or priority channel |
| `email.archive-resolved` | Archive threads via Nylas API that need no further action |
| `email.batch-triage` | Scheduled batch: fetch unprocessed emails, have the agent classify + label + surface in one pass |

**Handbook coverage:** Email Inbox Management, Label System, Daily Inbox Triage Flow,
End-of-Day Cleanup

**Dependencies:** Email channel (built). Needs Nylas label/folder API support added.

**Value justification & redesign notes:**

- ~~`email.classify`~~ — **Removed as a standalone skill.** Classification (urgency,
  category) is what the LLM does natively in-context. The agent's system prompt defines
  the classification rules; the LLM applies them. No skill needed — the LLM just decides
  and then calls `email.label` to apply its decision via the API.
- ~~`email.extract-actions`~~ — **Removed as a standalone skill.** Action extraction is
  native LLM capability. The agent does this in-context while reading the email. If
  extracted actions need to be persisted, that's a knowledge graph write — not a separate
  skill.
- ~~`email.summarize-thread`~~ — **Removed as a standalone skill.** Thread summarization
  is literally what the LLM does. Only justified as a batch job (e.g., nightly digest of
  long threads), in which case it's part of `email.batch-triage`, not standalone.
- `email.label` — **Justified.** API bridge to Nylas label/folder system. The LLM
  decides the label; the skill applies it.
- `email.surface-urgent` — **Justified.** Pushes notifications via bus events. Can't be
  done without a tool.
- `email.archive-resolved` — **Justified.** API bridge to Nylas archive. The LLM decides
  what's resolved; the skill moves it.
- `email.batch-triage` — **New.** Scheduler-triggered skill that fetches the inbox and
  lets the agent process it in one pass. This is where the orchestration value lives —
  not in individual classify/summarize skills, but in the pipeline that feeds email to
  the agent and collects its decisions.

---

### 3. Executive Profile Agent — `paid`

Learns and maintains the CEO's communication style, preferences, and patterns. The
institutional knowledge engine. Can bootstrap voice/tone analysis from day one by
scanning the CEO's sent email history via Nylas.

| Skill | What it does |
|---|---|
| `profile.analyze-voice` | Scan sent emails (via Nylas) to build a voice/tone model |
| `profile.validate-draft` | Check if a draft email matches CEO's voice, suggest adjustments |
| `profile.update-preferences` | Store learned preferences (meeting defaults, travel, dietary, etc.) |
| `profile.get-preferences` | Retrieve preferences by category for other agents to use |
| `profile.detect-patterns` | Analyze email/calendar patterns (response timing, style by audience) |
| `profile.executive-snapshot` | Maintain and serve the structured executive snapshot |

**Handbook coverage:** Executive Snapshot, Learning Exec Preferences, CEO Preferences,
Personality Insights, Drafting Emails in CEO's voice

**Dependencies:** Email channel (built), Knowledge graph (built). Voice analysis needs a
one-time batch scan of sent mail via Nylas.

**Note:** The handbook warns that voice matching takes months of observation. With access
to the CEO's sent email archive, Curia can analyze hundreds of emails on day one to
bootstrap tone, formality, sign-off style, and audience-specific variation.

**Value justification & redesign notes:**

- `profile.analyze-voice` — **Justified.** The value is in the *batch orchestration* +
  *persistence*, not the analysis itself. The LLM does the analysis; the skill orchestrates
  scanning hundreds of sent emails via Nylas and storing the resulting voice model in the
  knowledge graph. This can't happen in a single conversation turn.
- `profile.validate-draft` — **Justified, but skill should be retrieval-only.** The skill
  retrieves the stored voice model from the KG and returns it. The LLM compares the draft
  against the model. The skill should NOT try to do the comparison itself — that's
  LLM-native work.
- `profile.update-preferences` / `profile.get-preferences` — **Justified.** Deterministic
  storage and retrieval. Same pattern as the knowledge skills.
- ~~`profile.detect-patterns`~~ — **Needs scrutiny.** Pattern detection (response timing,
  style by audience) is LLM analysis. The skill is only justified if it runs as a batch
  job that *persists* the detected patterns. If it's on-demand, the LLM can detect
  patterns in-context without a skill. **Redesign**: make this a scheduled batch job that
  scans recent email/calendar data and stores observed patterns.
- `profile.executive-snapshot` — **Justified.** Structured data retrieval from the KG.
  The snapshot is a compiled, persistent artifact — not something the LLM re-derives
  each time.

---

### 4. Briefing Agent — `paid`

Assembles structured data packages from multiple sources (calendar, contacts, email,
knowledge graph) and lets the agent compose briefings from the assembled context. The
skills are data pipelines, not text generators.

| Skill | What it does |
|---|---|
| `briefing.gather-daily` | Aggregate today's calendar, pending action items, unread urgents, OOO contacts into a structured data package |
| `briefing.gather-weekly` | Aggregate next 7 days of calendar, open threads, travel, reminders into a structured data package |
| `briefing.gather-meeting-prep` | For a given meeting: fetch attendee contact records, last interaction from KG, meeting context, related documents |
| `briefing.gather-travel` | For a given trip: compile flights, hotel, ground transport, dinner reservations, calendar links from KG + calendar |
| `briefing.gather-board-prep` | For a board meeting: attendees, agenda, materials checklist, related KG context |

**Handbook coverage:** Daily Briefing Template, Week Ahead Email, Meeting Prep,
Travel Itinerary Template, Board Engagement prep, Look Ahead Always

**Dependencies:** Calendar Agent (#1), Contact system (built), Knowledge graph (built).
Scheduler (spec 07) needed for automated daily/weekly delivery. Partially usable
without Scheduler via on-demand requests.

**Value justification & redesign notes:**

The original skill names (`briefing.daily`, `briefing.weekly-look-ahead`, etc.) implied
the *skill* generates the briefing text. That's a downgrade — the LLM writes better
prose than any templated skill. **Renamed to `gather-*`** to make the job clear: each
skill is a data aggregation pipeline that assembles context from multiple APIs and the
knowledge graph, then returns structured data. The *agent* (LLM) writes the briefing
using that data, adapting format, tone, and emphasis to what actually matters that day.

This also means briefing *format preferences* (e.g., "I want bullet points, not
paragraphs" or "always lead with the most important meeting") should be stored as
guidelines in the KG, retrievable by the agent when composing. The skills gather data;
the agent follows guidelines to compose.

---

### 5. Meeting Coordinator — `paid`

Handles the back-and-forth of setting up meetings with people. Proposes times, sends
emails, manages rescheduling and cancellation. Delegates to Calendar Agent for the
actual calendar operations.

| Skill | What it does |
|---|---|
| `meeting.propose-times` | Generate 3 time options based on CEO availability and preferences |
| `meeting.send-request` | Email meeting request on behalf of CEO (uses handbook templates) |
| `meeting.reschedule` | Handle rescheduling flow - propose new times, update calendar |
| `meeting.cancel` | Send cancellation email, remove calendar event |
| `meeting.intake-request` | Parse inbound speaking/meeting requests, extract structured fields |
| `meeting.coordinate` | Multi-turn email coordination with external parties until booked |
| `meeting.confirm` | Send confirmation with Zoom link, agenda, and context |

**Handbook coverage:** Meeting Request templates, Rescheduling, Canceling, Handling
CEO Time & Speaking Engagements, Meeting Prep Checklist

**Dependencies:** Calendar Agent (#1), Email channel (built), Outbound content filter (built)

**Value justification & redesign notes:**

- `meeting.propose-times` — **Justified.** Queries calendar availability via API. The LLM
  can't read the calendar without this.
- `meeting.send-request` — **Partially justified, needs redesign.** The sending part
  (email API) is justified. But the skill should NOT compose the email. It should
  retrieve the meeting-request email policy/guidelines from the KG, return them to the
  agent, and let the LLM compose. Then the agent calls `email-send`. This skill may
  collapse into just the guidelines retrieval.
- `meeting.reschedule` / `meeting.cancel` — **Same redesign.** The calendar mutation and
  email sending are justified API calls. The email composition is LLM work guided by
  policies retrieved from the KG.
- ~~`meeting.intake-request`~~ — **Removed as standalone skill.** Parsing inbound requests
  and extracting structured fields is native LLM capability. The agent does this
  in-context when it receives the email.
- `meeting.coordinate` — **Justified.** Multi-turn state management across email exchanges
  is genuinely complex orchestration that benefits from a skill tracking the state machine
  (proposed → awaiting response → counter-proposed → confirmed).
- `meeting.confirm` — **Justified.** Sends confirmation email with Zoom link, creates
  calendar event. API bridge work.

---

### 6. Proactive Calendar Agent — `paid`

Scheduler-triggered agent that reviews the CEO's upcoming calendar and flags issues
before they become problems. The "see around corners" agent. When it identifies
something to fix, it routes through the Coordinator to the Calendar Agent rather than
modifying the calendar directly.

| Skill | What it does |
|---|---|
| `proactive-cal.detect-overload` | Flag days with >6 meetings or no breaks |
| `proactive-cal.detect-back-to-backs` | Identify clusters of back-to-back meetings, suggest buffer insertion |
| `proactive-cal.travel-recovery` | Flag light-schedule needs after travel days |
| `proactive-cal.missing-context` | Find calendar events without descriptions, Zoom links, or attendees |
| `proactive-cal.stale-recurring` | Detect recurring meetings that haven't been attended or may be obsolete |
| `proactive-cal.focus-time-check` | Verify focus time blocks haven't been overwritten |
| `proactive-cal.weekly-report` | Summary of calendar health, email volume, response patterns |

**Handbook coverage:** Look Ahead Always, Schedule Focus Time, Calendar Hygiene Rules,
Miscellaneous (But Actually Crucial)

**Dependencies:** Calendar Agent (#1), Scheduler (spec 07). Cron-triggered, not
request-triggered.

**Design note:** This is separate from the Calendar Agent despite operating on the same
data. The Calendar Agent is request-triggered with a tool-focused prompt ("manage
calendar operations"). The Proactive Calendar Agent is cron-triggered with an evaluative
prompt ("review the calendar and flag problems"). Different invocation patterns and
cognitive modes warrant separate agents.

**Value justification & redesign notes:**

Most of these skills (detect-overload, detect-back-to-backs, missing-context, etc.)
are **evaluation tasks** the LLM can do natively if given the calendar data. The skills
are justified not because the detection logic is hard, but because:

1. They run on a **schedule** (cron-triggered, no user prompt)
2. They **fetch data** the LLM can't access without API tools (calendar events for the
   next N days)
3. They **route findings** through the bus to notify the CEO

The skills should focus on data fetching and routing, not on implementing detection rules
in code. The agent's system prompt defines what "overload" or "back-to-back" means; the
LLM evaluates the data. The skill fetches the calendar window and returns it to the agent.

Consider consolidating: instead of 6 separate detection skills, a single
`proactive-cal.fetch-week` skill that returns the next 7 days of calendar data, and
the agent's prompt tells it what to look for. The weekly-report skill is justified as
a separate data aggregation pipeline.

---

### 7. Escalation Agent — `core`

Implements the handbook's urgent communication protocol across available digital
channels.

| Skill | What it does |
|---|---|
| `escalation.assess-urgency` | Determine if a situation is red (immediate) or orange (important) |
| `escalation.notify-ceo` | Attempt to reach CEO via available channels with escalating intensity |
| `escalation.notify-backup` | Route to designated backup (COO, CFO) if CEO unreachable |
| `escalation.log-attempt` | Audit-log each escalation attempt with timestamps |

**Handbook coverage:** Urgent Communication Plan with CEO (all three scenarios, digital
portions only)

**Dependencies:** Email (built), CLI (built). Slack channel and SMS/Signal would
dramatically increase value. Minimal viable version works with email + CLI.

**Value justification & redesign notes:**

- ~~`escalation.assess-urgency`~~ — **Removed as standalone skill.** Urgency assessment
  is LLM-native. The agent's system prompt defines the red/orange criteria from the
  handbook; the LLM evaluates the situation in-context.
- `escalation.notify-ceo` — **Justified.** Multi-channel notification is an API/bus
  operation. The skill sends via available channels with escalating intensity.
- `escalation.notify-backup` — **Justified.** Routing to backup contacts requires KG
  lookup + notification. API bridge.
- `escalation.log-attempt` — **Justified, but may not need a separate skill.** The audit
  logger already captures all bus events. This skill is only justified if escalation logs
  need a different format or destination than the standard audit trail. Consider whether
  the bus audit hook already covers this.

---

## Coordinator Skills — `core`

Skills the Coordinator (already built) uses directly, not attached to a specialized agent.
Split into two categories: email policy skills and knowledge skills.

### Email Policy Skills

These skills store and retrieve **composing guidelines** — not rigid fill-in-the-blanks
templates. The LLM composes the actual email; the skill provides the organizational
policy, required structural elements, tone constraints, and an example email as reference.

The output of a `generate` call is a structured policy object the LLM uses as
instructions, not a finished email. This is better than both hardcoded templates (rigid,
can't adapt) and bare LLM behavior (no organizational consistency).

| Skill | What it does | Handbook coverage |
|---|---|---|
| `template.meeting-request` | Retrieve meeting-request email policy (required elements, tone, structure, example) | Meeting Request template (p.53) |
| `template.reschedule` | Retrieve rescheduling email policy | Rescheduling template (p.54) |
| `template.cancel` | Retrieve cancellation email policy | Canceling template (p.55) |
| `template.doc-request` | Retrieve pre-meeting materials request policy | Requesting Docs template (p.55) |

Each skill supports three actions:
- **`generate`** — returns the policy (checks KG for user-customized version first,
  falls back to built-in defaults). The policy includes: required structural elements,
  tone/formality guidelines, constraints, and an example email.
- **`save`** — stores a custom policy in the knowledge graph, overriding the defaults.
  The CEO can tell the agent "from now on, meeting requests should always mention my
  assistant's availability too" and the agent saves that as a policy update.
- **`reset`** — removes the custom policy and reverts to built-in defaults.

~~`template.linkedin-response`~~ — **Removed.** LinkedIn API is too restrictive for
automated use (noted in the "Not Addressed" section). A template for something we can't
send is dead weight.

### Knowledge Skills

Structured, deterministic storage and retrieval. These are justified because the data
must be stored and recalled *exactly* — not paraphrased by an LLM.

| Skill | What it does | Handbook coverage |
|---|---|---|
| `knowledge.company-overview` | Store/retrieve company legal name, address, officers, board | Company Overview & Contact Lists (p.19-21) |
| `knowledge.meeting-links` | Store/retrieve personal Zoom/Teams links for leadership | Virtual Meeting Access (p.32-33) |
| `knowledge.travel-preferences` | Store/retrieve travel prefs (seat, airline, loyalty, baggage) | Travel Booking Preferences (p.37-38) |
| `knowledge.loyalty-programs` | Store/retrieve airline/hotel loyalty numbers | Travel Booking Info (p.38-39) |

### Context Assembly Skill

A single skill that bridges the gap between siloed knowledge and the LLM's need for
complete context in one call.

| Skill | What it does | Handbook coverage |
|---|---|---|
| `context.for-email` | Given an email type and recipient, assemble: email policy + contact info + meeting link (if on file) + audience preferences + last interaction from KG. Returns everything the LLM needs to compose in one call. | Cross-cutting: supports all email-generating tasks |

This skill exists because the alternative — the LLM making 4-5 sequential tool calls
to gather context — is fragile, token-expensive, and gets worse as the number of
knowledge sources grows. The skill does the plumbing; the LLM does the thinking.

### Known Gaps and Planned Improvements

**These are known limitations of the current Coordinator Skills implementation.** They
are documented here so future development addresses them intentionally rather than
rediscovering them.

#### Email Policy Skills

1. **Policies are static without a feedback loop.** Once set, they don't evolve from
   usage. The CEO rewrites 20 meeting request emails to be shorter — the system
   learns nothing. **Mitigation (implemented):** The `update` action accepts
   natural-language refinements ("make these less formal", "always mention my
   assistant can help with scheduling") and merges them into the existing policy.
   The skill uses the LLM to interpret the refinement and update the structured policy.

2. **Policies are audience-blind.** One policy for every recipient. Board chairs,
   engineering partners, and vendors all get emails shaped by the same guidelines.
   **Future:** Support audience-tagged policy variants. The policy resolution checks
   for audience-level overrides (by role, relationship type, or specific contact)
   before falling back to the general policy. Requires the contact system to carry
   audience metadata.

3. **Example emails are frozen fiction.** They don't reflect the CEO's actual voice.
   **Future:** When the Executive Profile Agent ships, the template skills should pull
   the CEO's voice model into the guidelines automatically. Example emails should be
   *regenerated from the voice model*, not static strings. This is a dependency on
   the Profile Agent — design the policy structure to accept a `voice_model_id` field
   now so the integration is mechanical later.

4. **No version history.** After updating a policy 5 times, there's no way to see what
   it looked like before or roll back a bad change. **Future:** Store policy versions
   as separate fact nodes with timestamps, and add a `history` action that returns
   past versions. Low priority but useful for trust-building ("show me what changed").

#### Knowledge Skills

5. **They're a flat key-value store.** The knowledge graph supports semantic search,
   relationship traversal, and cross-entity connections. The knowledge skills use none
   of this — they store facts by exact label and retrieve by exact label.
   **Future:** Add semantic search to the retrieve action so "airline preferences" finds
   "preferred_airline" and "frequent_flyer" without exact label matches.

6. **No freshness tracking.** Meeting links get rotated, loyalty tiers change, company
   officers turn over. There's no mechanism to flag stale data or prompt
   re-confirmation. **Future:** Use the temporal metadata (lastConfirmedAt) to surface
   "this was last confirmed 6 months ago — is it still current?" warnings when facts
   are retrieved. The decay classes are already in the data model; the skills just
   don't read them yet.

7. **No cross-referencing.** Travel preferences, loyalty programs, meeting links, and
   company info live in separate anchor nodes with no edges between them.
   **Mitigation (implemented):** The `context.for-email` assembly skill bridges this
   gap for email composition. **Future:** Extend the pattern to other task types
   (travel planning, meeting prep, board engagement).

---

## Distribution Tiers: Open Source Core vs. Paid SaaS

Curia follows an open-core model: a genuinely useful open source core that drives
adoption and community, with a paid SaaS tier that adds intelligence, personalization,
and proactive capabilities.

**Guiding principle:** Open source = reactive, functional EA. Paid = proactive,
intelligent, learns and anticipates.

### Open Source Core

| Agent / Skill Group | Skills | Rationale |
|---|---|---|
| **Calendar Agent** | All 9 skills | Table stakes. An EA system without calendar management isn't an EA system. This is what gets people to try Curia. |
| **Email Triage Agent** (basic) | `email.label`, `email.surface-urgent`, `email.archive-resolved`, `email.batch-triage` | API bridges for inbox management. Classification and summarization are LLM-native — no skill needed for those. |
| **Coordinator Skills** | 4 email policy + 4 knowledge = 8 skills | Email policies provide organizational consistency; knowledge skills store exact data. The "getting started" experience. |
| **Escalation Agent** | `escalation.notify-ceo`, `escalation.notify-backup` (+ audit via bus) | Safety feature. Urgency assessment is LLM-native; notification routing needs API tools. |

A self-hosted Curia with these four groups can manage a calendar, triage email,
store company knowledge, follow email policies, and escalate urgent items. That's
a functional, if basic, AI EA — enough to build a community, attract contributors, and
create a funnel.

### Paid SaaS Tier

| Agent / Skill Group | Skills | Rationale |
|---|---|---|
| **Executive Profile Agent** | 5 skills (analyze-voice, validate-draft, update/get-preferences, executive-snapshot) | Highest-value differentiator. Voice analysis, preference learning, draft validation — this is what makes Curia feel like *your* EA. Batch analysis + persistence are the value, not LLM-native tasks repackaged. |
| **Briefing Agent** | 5 `gather-*` skills | Data aggregation pipelines. The LLM writes the briefing; the skills assemble the data from calendar + contacts + KG. Habit-forming daily/weekly delivery drives retention. |
| **Meeting Coordinator** | 5 skills (propose-times, reschedule, cancel, coordinate, confirm) | Multi-turn email coordination is operationally complex. API bridges + state machine orchestration. High time-saving value. |
| **Proactive Calendar Agent** | 2 skills (fetch-week, weekly-report) + agent prompt | The "exceed human EA" agent. Consolidated from 7 skills to 2 data-fetching skills — the LLM evaluates the data, the prompt defines what to look for. Proactive is premium. |

### Tier Comparison

| Factor | Open Source Core | Paid SaaS |
|---|---|---|
| Cognitive mode | Reactive (user asks, system does) | Proactive (system anticipates, suggests, acts) |
| LLM cost | Lower (classification, CRUD) | Higher (multi-turn coordination, voice analysis, summarization) |
| Stickiness | Useful but replaceable | Habit-forming, personalized, hard to leave |
| Adoption role | Gets people in the door, builds community | Converts users to customers, drives revenue |
| Self-host difficulty | Straightforward | Needs tuning, operational refinement, higher infra cost |

### Deployment Architecture Implications

The paid SaaS agents and skills must live in a **separate private repository**, not in the
open source `curia` repo. During SaaS deployment, the paid repo's agents and skills are
folded into the build alongside the open source core.

This has direct implications for the operations/deployment plan (spec 08):

- **Agent discovery:** The bootstrap process (`src/index.ts`) already loads agents from
  `agents/*.yaml` and skills from `skills/*/skill.json`. The SaaS deploy pipeline must
  merge agent/skill directories from both repos before boot.
- **Feature gating:** The Email Triage Agent spans both tiers (4 basic skills in core,
  2 advanced in paid). The skill manifest or agent config needs a mechanism to
  declare tier requirements so the loader can skip paid skills in the open source build.
- **Config separation:** Paid agent YAML configs reference paid skills. If those skills
  aren't present (open source deploy), the agent must either not load or gracefully
  degrade.
- **CI/CD:** The SaaS repo needs its own CI that tests against the core repo at a pinned
  version, ensuring paid agents remain compatible with the core framework.
- **Licensing:** The core repo uses an open source license. The paid repo is proprietary.
  No paid code should ever leak into the core repo, even as imports or type references.

This deployment split should be designed as part of the Docker/Terraform work in spec 08.
Until then, all agents and skills can be developed in the core repo and extracted later
when the paid tier is ready to ship.

---

## Stack Ranking: Coverage vs. Effort

| Rank | Agent | Tier | Handbook Domains Covered | Effort | Dependencies | Notes |
|---|---|---|---|---|---|---|
| **1** | **Calendar Agent** (9 skills) | core | Calendar Mgmt, Meeting Setup, Focus Time, Travel Blocks, Board Scheduling, Calendar Hygiene | **Large** (2-3 weeks) | Google Calendar API OAuth | Unlocks agents #4, #5, #6. Build first. |
| **2** | **Email Triage Agent** (4 skills) | core | Email Inbox Mgmt, Label System, Daily Triage | **Medium** (1-2 weeks) | Email channel (built), Nylas label API | Classification/summarization are LLM-native — only API bridges here. |
| **3** | **Executive Profile Agent** (5 skills) | paid | Exec Snapshot, Learning Preferences, Voice Matching, Drafting Quality | **Medium** (1-2 weeks) | Email channel (built), Knowledge graph (built) | Voice analysis is a force multiplier for all outbound skills. |
| **4** | **Briefing Agent** (5 `gather-*` skills) | paid | Daily Briefing, Weekly Look-ahead, Meeting Prep, Travel Itinerary, Board Prep | **Medium** (1-2 weeks) | Calendar Agent (#1), Scheduler (spec 07) | Data aggregation pipelines. LLM composes; skills assemble. |
| **5** | **Meeting Coordinator** (5 skills) | paid | Meeting Requests, Rescheduling, Cancellation, Speaking Engagements | **Large** (2-3 weeks) | Calendar Agent (#1), Email channel (built) | Multi-turn coordination is complex. Intake parsing is LLM-native. |
| **6** | **Coordinator skills** (8 skills) | core | Email policies, Company Knowledge, Meeting Links, Travel Prefs | **Small** (3-5 days) | Knowledge graph (built) | Low effort, fills gaps immediately. Build in parallel with anything. |
| **7** | **Proactive Calendar Agent** (2 skills + agent prompt) | paid | Look Ahead, Focus Time, Calendar Hygiene, Back-to-back Detection | **Small-Medium** (1 week) | Calendar Agent (#1), Scheduler (spec 07) | Consolidated: data-fetching skills + evaluative prompt. |
| **8** | **Escalation Agent** (2 skills) | core | Urgent Comms Plan (digital portions) | **Small** (3-5 days) | Needs Slack channel for real value | Urgency assessment is LLM-native. Skills handle notification routing. |

---

## Recommended Build Phases

```
Phase A (foundation):  Calendar Agent + Coordinator skills (email policies + knowledge)
Phase B (intelligence): Email Triage Agent + Executive Profile Agent
Phase C (automation):   Briefing Agent + Meeting Coordinator
Phase D (proactive):    Proactive Calendar Agent + Escalation Agent
```

Phase A unlocks everything downstream. The coordinator skills (email policies and
knowledge storage) are low-effort, high-value foundations that can ship alongside
Calendar Agent work. Phase B makes Curia "smart" about email and voice. Phase C is
where Curia starts saving the CEO real time. Phase D is where it starts anticipating
needs before being asked.

**Totals: 7 agents + 1 skill group = ~38 skills covering ~85% of the handbook's
actionable domains.** (Down from 53 in the original plan — 15 skills removed as
LLM-native capabilities that don't benefit from being wrapped in a skill.)

---

## Where Curia Excels Beyond a Human EA

1. **Always-on availability** - The handbook's urgent comms plan has 1-minute and
   5-minute response windows. Curia never sleeps, never takes lunch.
2. **Perfect consistency** - Color coding, naming conventions, template formats,
   label systems. Curia will never drift or get sloppy.
3. **Audit trail** - Every action is logged. The handbook's confidentiality section is
   about trust; Curia provides proof via its audit system.
4. **Parallel processing** - A human EA triages email serially. Curia can triage,
   draft, schedule, and prep simultaneously.
5. **Institutional memory** - The handbook urges EAs to document everything
   because humans forget. Curia's knowledge graph is the documentation.
6. **Handoff-proof** - The handbook has an entire section on onboarding/offboarding
   an EA. Curia doesn't leave.
7. **Voice learning at speed** - The handbook says voice matching takes months of
   observation. With Nylas access to sent mail, Curia can analyze hundreds of
   emails on day one.

---

## Handbook Coverage Not Addressed

These domains from the handbook are infeasible for a multi-agent system:

| Domain | Why |
|---|---|
| Physical gatekeeping (closing doors, signage, intercepting walk-ins) | No physical presence |
| Coffee/meal runs, printing decks, watering plants | No physical presence |
| Joining Zoom to interrupt someone in a meeting | No audio/video meeting participation |
| Shadowing meetings to learn exec's presentation style | No audio/video observation |
| Reading body language, sensing stress, gauging comfort levels | No visual/spatial awareness |
| LinkedIn management (connection requests, message replies) | LinkedIn API is too restrictive for automated use |
| Managing physical ID documents (passport photos, driver's license) | Security risk for an AI system to store government ID |
| Being a personal confidant for sensitive personal matters | Can listen and respond, but cannot replace human trust |

---

## Credits

This plan was derived from analysis of _The Executive Assistant Handbook: Your CEO's
Life, Organized_ (v1.0, July 2025) by **Stephanie Martin**, Senior Executive Assistant.
The handbook provided the real-world EA domain expertise that grounds this agent
architecture. Curia's agent and skill design aims to automate the systems and processes
Stephanie documented, within the constraints of a software system.
