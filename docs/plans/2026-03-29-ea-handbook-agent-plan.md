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

---

### 2. Email Triage Agent — `core` (basic) / `paid` (advanced)

Processes inbound email, classifies by urgency/type, extracts action items, applies
labels, surfaces what needs CEO attention. Works on top of the existing email channel.

Basic skills (`classify`, `label`, `surface-urgent`, `archive-resolved`) are in the
open source core. Advanced skills (`extract-actions`, `summarize-thread`) are paid tier.

| Skill | What it does |
|---|---|
| `email.classify` | Assign urgency (red/yellow/purple) and category (action/FYI/delegate) |
| `email.extract-actions` | Pull out action items, deadlines, asks from email body |
| `email.summarize-thread` | Produce 2-3 sentence summary of a long thread |
| `email.label` | Apply triage labels to messages (maps to handbook's label system) |
| `email.surface-urgent` | Push urgent items to CEO via CLI notification or priority channel |
| `email.archive-resolved` | Identify and archive threads that need no further action |

**Handbook coverage:** Email Inbox Management, Label System, Daily Inbox Triage Flow,
End-of-Day Cleanup

**Dependencies:** Email channel (built). Needs Nylas label/folder API support added.

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

---

### 4. Briefing Agent — `paid`

Generates structured briefings and prep documents. Template-driven but context-aware.

| Skill | What it does |
|---|---|
| `briefing.daily` | Morning briefing: today's schedule, notes, FYIs, OOO teammates |
| `briefing.weekly-look-ahead` | Week-ahead email: highlights, travel, reminders, open items |
| `briefing.meeting-prep` | Pre-meeting brief: attendee bios, last interaction, context, talking points |
| `briefing.travel-itinerary` | Compile full travel doc: flights, hotel, ground transport, dinner reservations, calendar links |
| `briefing.board-prep` | Board meeting brief: attendees, agenda, materials checklist, prep/debrief blocks |

**Handbook coverage:** Daily Briefing Template, Week Ahead Email, Meeting Prep,
Travel Itinerary Template, Board Engagement prep, Look Ahead Always

**Dependencies:** Calendar Agent (#1), Contact system (built), Knowledge graph (built).
Scheduler (spec 07) needed for automated daily/weekly delivery. Partially usable
without Scheduler via on-demand requests.

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

---

## Coordinator Template Skills — `core`

Skills the Coordinator (already built) uses directly, not attached to a specialized agent:

| Skill | What it does | Handbook coverage |
|---|---|---|
| `template.meeting-request` | Generate meeting request email from handbook template | Meeting Request template (p.53) |
| `template.reschedule` | Generate rescheduling email | Rescheduling template (p.54) |
| `template.cancel` | Generate cancellation email | Canceling template (p.55) |
| `template.doc-request` | Generate pre-meeting materials request | Requesting Docs template (p.55) |
| `template.linkedin-response` | Generate LinkedIn-style connection response | LinkedIn Connection Responses (p.52) |
| `knowledge.company-overview` | Store/retrieve company legal name, address, officers, board | Company Overview & Contact Lists (p.19-21) |
| `knowledge.meeting-links` | Store/retrieve personal Zoom/Teams links for leadership | Virtual Meeting Access (p.32-33) |
| `knowledge.travel-preferences` | Store/retrieve travel prefs (seat, airline, loyalty, baggage) | Travel Booking Preferences (p.37-38) |
| `knowledge.loyalty-programs` | Store/retrieve airline/hotel loyalty numbers | Travel Booking Info (p.38-39) |

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
| **Email Triage Agent** (basic) | `email.classify`, `email.label`, `email.surface-urgent`, `email.archive-resolved` | Basic triage is necessary for the system to be useful with email. People need to see Curia actually do something with their inbox. |
| **Coordinator Template Skills** | All 9 skills | Templates, knowledge storage, meeting links - these are the "getting started" experience. Low cost to give away, high cost if missing. |
| **Escalation Agent** | All 4 skills | Safety feature. If Curia handles email and calendar, it must be able to escalate urgent situations. Gating this behind a paywall would erode trust. |

A self-hosted Curia with these four groups can manage a calendar, triage email at a
basic level, store company knowledge, use templates, and escalate urgent items. That's
a functional, if basic, AI EA - enough to build a community, attract contributors, and
create a funnel.

### Paid SaaS Tier

| Agent / Skill Group | Skills | Rationale |
|---|---|---|
| **Executive Profile Agent** | All 6 skills | Highest-value differentiator. Voice analysis, preference learning, draft validation - this is what makes Curia feel like *your* EA rather than a generic assistant. Hard to replicate well with self-hosting because it needs tuning and operational refinement. |
| **Briefing Agent** | All 5 skills | Daily and weekly briefings create a habit. The CEO opens Curia's briefing every morning. Habit-forming features drive retention and make churn painful. |
| **Meeting Coordinator** | All 7 skills | Multi-turn email coordination is operationally complex, high LLM cost (many turns per meeting), and high-value. This is where Curia saves the most time. |
| **Proactive Calendar Agent** | All 7 skills | The "exceed human EA" agent. Proactive features are the clearest paid-tier differentiator - Curia doing things the CEO didn't ask for. Reactive is free. Proactive is premium. |
| **Email Triage Agent** (advanced) | `email.extract-actions`, `email.summarize-thread` | Intelligence-heavy features that cost more LLM tokens and provide significantly more value than basic classification. |

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
| **2** | **Email Triage Agent** (6 skills) | core/paid | Email Inbox Mgmt, Label System, Daily Triage, Drafting | **Medium** (1-2 weeks) | Email channel (built), Nylas label API | 4 basic skills core, 2 advanced skills paid. |
| **3** | **Executive Profile Agent** (6 skills) | paid | Exec Snapshot, Learning Preferences, Voice Matching, Drafting Quality | **Medium** (1-2 weeks) | Email channel (built), Knowledge graph (built) | Voice analysis is a force multiplier for all outbound skills. |
| **4** | **Briefing Agent** (5 skills) | paid | Daily Briefing, Weekly Look-ahead, Meeting Prep, Travel Itinerary, Board Prep | **Medium** (1-2 weeks) | Calendar Agent (#1), Scheduler (spec 07) | High CEO-perceived value. Partially usable without Scheduler. |
| **5** | **Meeting Coordinator** (7 skills) | paid | Meeting Requests, Rescheduling, Cancellation, CEO Time Requests, Speaking Engagements | **Large** (2-3 weeks) | Calendar Agent (#1), Email channel (built) | Multi-turn coordination is complex. High time-saving value. |
| **6** | **Coordinator template skills** (9 skills) | core | Email templates, Company Knowledge, Meeting Links, Travel Prefs | **Small** (3-5 days) | Knowledge graph (built) | Low effort, fills gaps immediately. Build in parallel with anything. |
| **7** | **Proactive Calendar Agent** (7 skills) | paid | Look Ahead, Focus Time, Calendar Hygiene, Back-to-back Detection | **Medium** (1-2 weeks) | Calendar Agent (#1), Scheduler (spec 07) | Highest "exceed human EA" potential. Blocked on Scheduler. |
| **8** | **Escalation Agent** (4 skills) | core | Urgent Comms Plan (digital portions) | **Small-Medium** (1 week) | Needs Slack channel for real value | MVP with email+CLI is small. Full value needs more channels. |

---

## Recommended Build Phases

```
Phase A (foundation):  Calendar Agent + Coordinator template skills
Phase B (intelligence): Email Triage Agent + Executive Profile Agent
Phase C (automation):   Briefing Agent + Meeting Coordinator
Phase D (proactive):    Proactive Calendar Agent + Escalation Agent
```

Phase A unlocks everything downstream. The template skills are low-effort gap-fillers
that can ship alongside Calendar Agent work. Phase B makes Curia "smart" about email
and voice. Phase C is where Curia starts saving the CEO real time. Phase D is where it
starts anticipating needs before being asked.

**Totals: 7 agents + 1 skill group = 53 skills covering ~85% of the handbook's
actionable domains.**

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
