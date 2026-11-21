# Onboarding program — design (#2360)

**Status:** Draft, 2026-11-20 (revised the same day after the maintainer's review)
**Issue:** #2360 (milestone v0.46 - Onboarding Journey)
**Builds on:** `docs/wip/2026-10-29-onboarding-journey-design.md` (Phase 2, the journey this
implements), `docs/wip/2026-10-30-onboarding-hawd-model.md` (A1, A4, A5), spec 18
**Depends on (all merged):** #2358 Setup page, #2359 calls load the parked agenda, #2361
mailbox sign-in and `principal_mailbox.connected`, #2341 phone app and the 48-hour invitation,
#2683 sign in as Curia (Google Workspace)
**Released with:** #2362 deep dive. The two ship in the same release, so no install runs one
without the other and nothing here falls back for a missing deep dive.

## Intent

Curia's positioning: *the only private personal agent designed to handle people and priorities
with the finesse they expect from an experienced EA.* Onboarding is the first test of that. The
principal is asking one question throughout: **"How much work will it take before I can trust
this thing to act for me?"**

**Onboarding is Curia adapting to the principal, not the principal being onboarded.** A good EA's
first weeks are spent learning the person: doing their homework before the first meeting, asking
how they like to work, finding out who matters to them, telling them plainly what they'll start
to notice, and then proving it understood. Everything here, the playbook's wording included, is
written from that side: what Curia needs to learn and how it will adapt.

So onboarding should feel like this:

- Curia does its homework first, then reaches out briefly and says who set it up.
- The first conversation is about half an hour, mostly multiple choice, with one warm, open
  "tell me about yourself" part that starts from what Curia already found.
- The principal leaves knowing exactly what will change in their inbox and calendar, and why.
- Before it ends, Curia shows it already understands something real about the principal's week
  (the **first look**). That is the moment that answers the trust question.
- Everything after that is a session the principal agreed to, in the order they like, ending with
  an ongoing rhythm they chose (or none).

The journey design covers the *what*. This document covers how it's built on what Curia already
has, and the refinements agreed with the maintainer on 2026-11-20.

## What changed from the journey design and the issue

1. **Onboarding is one ordinary task with subtasks**, not a separate plan document plus a chat
   session engine. The task's progress is *what's happened*.
2. **The playbook is an OKF document the operator can edit** (`/meetings/onboarding/playbook.md`),
   Curia's own guide to adapting to this principal. It is seeded from a repo default when Setup
   begins and never refreshed.
3. **Chat sessions need no session machinery.** The coordinator works the open subtasks in the
   principal's thread. Voice keeps the parked agenda → minutes → follow-up path.
4. **Homework first.** At Start, Curia researches the principal on the open web and writes a
   research brief. Nothing from it reaches memory until the principal confirms it.
5. **"Tell me about yourself"** is a topic of its own, opened from the research brief.
6. **"What to expect" explains how Curia handles mail**, not just when triage starts, and offers
   the choices that already exist (labels, sending).
7. **A first look** closes the first conversation.
8. **Drives and imports** become one short topic. Side requests become their own tasks.
9. **The last Setup step offers "Start onboarding" or "Not right now"** (with a confirmation);
   a dashboard alert keeps Start onboarding available.
10. **No operator notification system.** A `notifyOperator` placeholder; delivery waits for the
    operator role (#2365).
11. **Done means every subtask is done** (completed or declined), in any order. Confirming the
    deep-dive drafts and agreeing a weekly session are no longer gates.
12. **No-show detection** is built for any calendar-tied agenda, not only onboarding sessions.
13. **Operator chat between Setup and Start is treated as the principal's**, as all console chat
    is today. Accepted until the console has identified logins.

## Goals

1. The operator starts onboarding when they choose, from Setup or later from the dashboard.
2. Curia does its homework on the principal before it says hello.
3. Curia greets the principal on the operator's chosen route and invites a first conversation of
   about half an hour, by voice or chat; follow-ups are capped.
4. The first conversation runs end to end by chat or by voice from the same playbook.
5. Every choice is applied while the principal is present, read back, and recorded.
6. The principal knows what Curia will do to their inbox before triage starts; triage then
   switches on without a restart.
7. Later sessions are booked one at a time on the principal's calendar; the agenda follows the
   event; a missed session is noticed and rebooked once.
8. Onboarding is done when every subtask is done.

## Non-goals

- An operator role, operator notifications, or operator identity in the console (#2365).
- A "leave everything in my inbox" option for triage (filed separately; not in this work).
- Bulk import tooling (CSV or vCard contacts, writing-sample ingestion).
- Refreshing a seeded playbook when the repo default changes.
- Curia calling out or joining Meet (#2231). Microsoft 365 principals.
- The deep dive and its inference heuristics (#2362). This issue books and runs the review.
- Calendar webhooks. Curia re-reads the event when it needs it.
- Operator-tunable onboarding settings. Timings are constants in code.

## Anti-goals (failure even if it technically works)

- **A questionnaire.** Scores, or more than a few questions without a read-back. ("Tell me about
  yourself" is deliberately open, and the only part that is.)
- **Visible surprises.** Mail leaving the inbox, labels appearing, drafts showing up, holds being
  placed before the principal was told.
- **Creepy homework.** Researching family, home or anything personal on the web, or stating a web
  finding as fact. Personal details come from the principal.
- **A first look that lectures.** Advice about how the principal runs their week, or an inference
  stated as fact. Findings are facts with offers.
- **Session spam.** A session the principal didn't agree to; more than one booked at a time; more
  than one "missed you" per missed session.
- **Onboarding hijacking the relationship.** A side request refused or deferred "until we finish
  onboarding".
- **Prompt sprawl.** Onboarding guidance in the coordinator's always-on prompt (ADR-046).
- **Pulling existing installs in.** Prod and other running installs never get a greeting, research
  or a triage change unless someone starts onboarding.
- **An over-built harness.** Tests pinning conversation wording, or scaffolding around what the
  model can do on its own.

## Approaches considered

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| **A** | **One onboarding task with subtasks, from an editable playbook.** An `onboarding` skill, active only for onboarding turns, tells the coordinator how to run it. Chat works the subtasks live; voice parks an agenda built from the open subtasks. | Reuses tasks, agendas, minutes and live-turn authority. The plan is a task list plus a playbook rather than one plan document. | **Chosen** |
| B | The issue as written: make the agenda tool work in chat, add a chat-session lifecycle (start, idle timeout, end), produce minutes from chat transcripts, keep a separate plan document. | One agenda mechanism for both routes, but it builds a chat-session runtime Curia has never had (the #2364 spike never ran) and roughly doubles the size. | Rejected |
| C | A dedicated onboarding agent owning the principal's thread, like the setup guide. | Clean prompt isolation, but the principal talks to a different agent than the one they'll use daily; side requests need a hand-back; voice still reaches the coordinator. | Rejected |

**Research findings: memory now, or a brief first.** Writing web findings straight to the
knowledge graph was rejected: a namesake's details could reach every agent's prompts before anyone
checked them, and a voice call can't query the graph mid-call anyway. A short research brief can be
read in one go, fits a voice agenda, and makes the "here's my homework, what did I get wrong?"
moment.

## Design

### 1. Parts and where they live

| Part | What it is | Where |
|---|---|---|
| **Playbook default** | Markdown in Curia's voice: one `#` section per session type, one `##` subsection per topic | repo fixture (path: builder's call) |
| **Playbook** | The install's copy, editable in Documents | OKF `/meetings/onboarding/playbook.md` |
| **Research brief** | What Curia found about the principal on the open web, with sources, each item marked unconfirmed / confirmed / corrected / dropped | OKF `/meetings/onboarding/research-brief.md` |
| **Onboarding task** | Parent task, owner `curia`, tagged `onboarding`; one subtask per topic; progress notes are *what's happened* | `tasks` |
| **`onboarding` skill bundle** | How Curia runs onboarding (§5), plus the tools onboarding needs | `skills/onboarding/` |
| **Code guarantees** | Triage hold, allowed autonomy bands, never-start-on-its-own, no-show detection | `src/onboarding/`, `src/meetings/` |

The skill holds *how Curia behaves*; it ships with the code. The playbook holds *what Curia needs
to learn*; it is the operator's to tailor. Nothing that must always hold lives in the playbook:
deleting a topic can only leave something off.

**Playbook voice and format.** Titled "Getting to know <principal>". Each topic says what Curia
needs to learn, how it will adapt, and suggested questions with options, and whether it needs the
mailbox. A stable topic id per subsection (format: builder's call). Example:

```markdown
# First conversation

## How I should sound  <!-- topic: style -->
I need to learn how <principal> likes me to talk to them, then adjust my tone and show them.
- Chatty and thorough, or brief and to the point?
- Dry, or a bit of humour?
- Warm and personable, or crisp and businesslike?
- When I'm not sure: ask, or make a sensible call and tell you?
Read back two lines in the chosen style; offer one round of tweaks.
```

### 2. Seeding the playbook

When Setup begins (`POST /api/setup/start`, which already runs only on a fresh database), Curia
copies the repo default to `/meetings/onboarding/playbook.md` if nothing is at that path. It is
never overwritten. An install that predates Setup gets it seeded the same way when someone starts
onboarding.

### 3. Starting onboarding

**Where.** The last Setup step becomes a choice:

- **Start onboarding.** Starts now (below), then opens the console.
- **Not right now.** Asks for confirmation first:
  - *Setting Curia up for themselves:* "Onboarding is where Curia learns how you like to work.
    It's required before Curia acts for you. You can start it any time from the dashboard."
  - *For someone else:* "Onboarding is <principal>'s first conversation with Curia. It's required
    before Curia acts for them. Start it from the dashboard when they're ready. Curia won't
    contact them until you do."

  Confirming ends Setup (phase complete, as today) without starting onboarding and opens the full
  console. The web thread is not rotated yet (step 6). The operator can explore, configure Curia
  and edit the playbook.

Until onboarding has started, the console dashboard shows an alert ("Onboarding hasn't started.
Start when <principal> is ready.") with a **Start onboarding** button. It shows only on an install
whose Setup was finished on the Setup page (`setup_state.completed_at` set by the page, not by
migration 130), so prod and other pre-Setup installs never see it.

**What Start does** (one server route; refuses while an onboarding task is open):

1. **Warn on a working principal.** If the install already looks in use (the Email triage
   capability is on, or the principal has tasks or conversation history from before Setup
   completed), the console asks for confirmation first. Exact signals: builder's call.
2. **Hold triage** (§7).
3. **Seed the playbook** if missing (§2).
4. **Create the onboarding task** with one subtask per topic of the *First conversation* section.
5. **Start the homework** (§4) in the background.
6. **Rotate the web thread** so the principal's first view is clean. (Today this happens when
   Setup completes; it moves here, so an operator who chose "Not right now" keeps their thread.)
7. **Reach the principal** on the messaging route from Setup:
   - **Curia app:** mint the 48-hour invitation (existing `pairing-invitations`) and show it with
     copyable wording that mentions the 48 hours, reusing the existing invitation panel. The
     greeting goes out when the invitation is redeemed: redemption publishes a new bus event (none
     exists today) that an onboarding subscriber turns into a task wake. If it expires unredeemed,
     Curia calls `notifyOperator('invitation_expired')`; the panel already shows "expired" and
     offers a new link. Follow-ups (§5) start only once Curia has a channel to the principal.
   - **Signal, SMS, Slack:** check Curia can reach the principal's id on that route (for Slack, a
     DM to the member id), then send the greeting. The console shows what was sent.
   - No email invitation.
8. **Solo executive** (Setup's "Myself"): the wording says the invitation is for them, and Curia
   offers to start the first conversation right there in the console.

**A principal can also ask** ("can we do the onboarding?"): the coordinator calls the same start
path through an `onboarding-start` tool. Nothing else starts onboarding.

### 4. Homework: researching the principal

As soon as onboarding starts, a background task (research-analyst, `web` bundle) searches the
open web for the principal's **professional public footprint**: company and what it does, role and
title, city, a public bio, recent news about them or their company. Not family, home, or personal
social accounts.

- It writes the **research brief** (§1): a short list of findings, each with its source and
  marked *unconfirmed*. Where results may belong to someone else with the same name, it says so.
- Nothing goes to memory yet.
- It also checks web search works on a fresh install. If search fails, Curia calls
  `notifyOperator('web_search_failed')` and the "tell me about yourself" topic simply starts open.
- The greeting doesn't mention the research.

### 5. The greeting and follow-ups

The greeting, in the principal's channel:

- who Curia is (name from Setup) and who set it up (the operator's name, or "you" when solo);
- a first conversation of about half an hour so Curia can learn how they like to work;
- how to do it by chat (just reply) or voice (tap to call, or call on Signal);
- nothing else.

If there's no reply, the onboarding task's wake time sends a follow-up, up to a fixed count and
gap (constants in `src/onboarding/`, not operator settings; defaults 2 follow-ups 48h apart).
After the last one, Curia stops and calls `notifyOperator('greeting_unanswered')`. Ad-hoc chat
works throughout.

### 6. Running a session

**How a turn picks up onboarding.** Task wakes (follow-ups, nudges, the connected event, booked
sessions) are task-bound turns, so they restore the `onboarding` skill from the task's active
skills, as the minutes follow-up does for `meetings`. An ordinary message from the principal
carries no task id, so **trigger-time injection** (ADR-046's second rung) covers it: while an
onboarding task is open, a principal turn on any channel (and the voice `async-offramp` hand-off)
gets the `onboarding` skill activated plus a short block naming the onboarding task and its open
subtasks. The turn isn't bound to the task, so a side request in the same message is handled
normally. Nothing is added to the always-on prompt.

**The `onboarding` skill's rules:**

- Work the open subtasks of the current session. The playbook gives the default order, but **the
  principal can take topics in any order** ("can we talk about drafts before I connect email?").
  Only topics that need the mailbox wait for it.
- Ask mostly multiple choice, as numbered options with "something else" as the escape. Read back
  what was heard after each topic.
- **Apply each choice as soon as it's confirmed** (§7), and mark the subtask done. If the
  principal declines a topic, mark it done with the reason.
- **Side requests** (research a trip, file an import, a question about a meeting) become separate
  tasks handed to the right agent async; say when to expect the result and return to the agenda.
  Never "after onboarding".
- **Deferrals.** "Something came up, can we do Thursday?": book Thursday, confirm in one line, don't
  push. A vague "later": offer two concrete times once; if still vague, let it go and follow up on
  the capped schedule (§5).

**Chat.** The coordinator runs the session in the principal's thread. A principal's chat turn is
already a live principal turn, so principal-authorized writes apply without an approval prompt.
If the principal goes quiet mid-session, the task's wake time sends one nudge after an idle
period (constant); after that the session is paused and open subtasks carry to the next one.

**Voice.** Before a voice session, Curia parks an agenda (`meeting-agenda-park`) built from the
open subtasks, the playbook text and, for "tell me about yourself", the research brief, with the
onboarding task id in its context. The call loads it (#2359). During the call, choices are applied
through `async-offramp` with a live-turn grant (#2495), so they take effect while the principal is
on the line; the voice tool list doesn't change. After the call, the existing minutes follow-up
marks covered subtasks done and applies anything outstanding; a write that lost its live grant
becomes a confirmation request, as today.

Either route can follow the other.

### 7. First conversation topics and the writes behind them

Default order; the principal can reorder.

| Topic | What Curia learns or explains | Applies | Through |
|---|---|---|---|
| Hello | Who Curia is, what this conversation is for | — | — |
| Tell me about yourself | Opens from the research brief ("I did a bit of homework; here's what I found; what did I get wrong?"), then a few open questions: family and the people who matter, interests outside work, what a good week looks like. Skippable. | Confirmed brief items → memory (source: the principal); corrections → memory; dropped items stay in the brief only. Family and key people → contacts with relationships | `memory-store`, `contact-create`; brief updated with `doc-write` |
| How I should sound | Paired style choices | `tone.style`, `tone.verbosity`, read back with a sample | **new** `office-tone-update` tool (no agent can write tone today) |
| How independent I should be | Draft only (65), Ask first (75, recommended), Spot-check (85) | autonomy score | `set-autonomy`, limited to those three values while an onboarding task is open (code) |
| How to reach you | Urgent vs routine; quiet hours; working hours; daily recap and time; unsent-drafts reminder | standing preferences; recap and drafts-reminder jobs | `behavioral-preferences-update`; `scheduler-create` (`daily_debrief` anchor; a drafts-reminder job) |
| Connect email and calendar | Why, and what Curia will and won't do with it; the sign-in link | grant | `mailbox-signin-link` (pinned to the onboarding skill too); if a mailbox is already connected, confirm which account instead |
| What you'll notice in your inbox | See below | choices; **triage released** (§8) | `ceo_inbox/decision_tagging`, `ceo_inbox/sending`; `onboarding-triage-release` |
| Spoken voice | One line: it can be changed under Behaviour → Personality | — | — |
| Drives and imports | §10 | drive map; follow-up tasks | §10 |
| How to review what I find | Call together, or review alone then text | recorded on the task | progress note |
| First look | §9 | offers, each its own action under the chosen band | existing calendar and ceo-inbox tools |
| Next step | When to review the drafts (booked once ready); how often to check in | the next session | §9 |

**"What you'll notice in your inbox."** Built from current settings when the session runs, so it
never promises behaviour Curia won't show. It explains:

- **How Curia sorts mail:** every message lands in one of six categories (Urgent, Handled, Drafted,
  Seen, Cleared, Stuck), with one line on what each means.
- **What each looks like in the mailbox:** Seen and Cleared mail is marked read and **leaves the
  inbox** (and where to find it); drafts **appear in the Drafts folder**; Urgent reaches them on
  their usual channel; Stuck is labelled.
- **The choices that exist today:** category **labels in Gmail on or off**
  (`ceo_inbox/decision_tagging`), and whether Curia may **send** anything itself or only draft
  (`ceo_inbox/sending`).
- **Calendar:** tentative holds Curia may place, the sessions it will book, and whether booking
  other meetings asks first at the band just chosen.
- A plain read-back: "From tomorrow morning you'll see…".

**Working style from Setup.** If the operator picked a tone or independence level in Setup
(identity history `changedBy: 'working_style'`, the autonomy history equivalent), the style and
independence topics present it as the current setting and ask keep-or-change.

**"Couldn't connect yet."** If the sign-in fails or is abandoned (`admin_blocked`,
`org_internal`, wrong account, partial grant, cancelled), Curia says why in plain words, calls
`notifyOperator('mailbox_signin_blocked', { outcome, clientId })`, leaves the subtask open and
carries on with topics that don't need the mailbox. When `principal_mailbox.connected` arrives
later, an onboarding subscriber wakes the task: Curia picks up the connect step, the inbox topic
and the first look in the next session or by message.

### 8. The triage hold

Agents load only at startup, so switching the Email triage capability on mid-conversation would
need a restart. Instead:

- **Start onboarding turns the Email triage capability on in the registry and sets a hold**
  (config-store key `onboarding/triage_hold`, a new key; not `ceo_inbox/triage`, which holds the
  per-mailbox cadences). Whether Start restarts Curia to load the agent, or Setup enables the
  capability (held) at Apply & restart: builder's call.
- **While the hold is set,** the inbox heartbeat, `inbox-drain` and the ceo-inbox crons do nothing
  that touches the principal's mailbox: no labels, archives, drafts or sends. Enforced in code at
  the heartbeat and in the mailbox-writing tools.
- **The inbox topic releases it** through `onboarding-triage-release` (principal-authorized,
  `action_risk: low`, refuses unless that subtask is done). Live, no restart.
- **A missing hold means no hold,** so existing installs keep triaging when this ships.
- Capabilities shows Email triage as "Held until <principal> hears what to expect". Switching it
  on in Settings clears the hold; switching it off works as today.
- **If onboarding stalls, the hold stays.** That is the safe state.
- **Cancelling.** The principal can say "stop the onboarding", or the task can be cancelled from
  the console's task view. The hold stays; Start can run again and creates a new task.

### 9. Sessions on the calendar

**Booking.** At the end of each session the principal and Curia agree the next one, and only that
one is booked:

- **Calendar connected:** a busy event on the principal's calendar, the principal the only
  attendee, titled for the session. Booking was agreed in the session, so if the band requires
  approval for a calendar write the principal gets the one prompt they were told about. The event
  id is stored on the subtask and on the parked agenda.
- **No calendar yet:** a scheduler job at the agreed time plus a nudge; it becomes an event once
  the calendar connects.

**The agenda follows the event** (general to any calendar-tied agenda, not only onboarding). No
webhooks: before each nudge, pre-session delivery or agenda park, Curia re-reads the event by id.

- **Moved:** reschedule the nudge, the delivery and the agenda's `scheduled_for`.
- **Cancelled:** ask once when to do it instead, and book the answer.
- **Late:** an agenda tied to an event stays loadable until it's done or replaced, instead of the
  ±12h `isDue` window (agenda frontmatter gains the event id; `isDue` treats event-tied agendas as
  due from 12h before the event until settled). `expires_at` still bounds it.
- **No-show:** after the event's end plus a grace period, if no call loaded the agenda (and, for a
  chat session, nothing was covered), the owning task wakes. For onboarding, Curia sends one
  "Missed you. When suits better?" and books the answer; silence falls back to the capped
  follow-ups. Any other calendar-tied agenda (a weekly kickoff, say) gets the same wake.

**The first look.** As soon as the mailbox is connected (at the start of the first conversation if
it was connected in Setup, otherwise when `principal_mailbox.connected` arrives), Curia runs a
background read bounded to **the last 7 days of email and the next 7 days of calendar**:

- email: threads waiting on the principal for more than a day or two; anything that looks urgent;
- calendar: double-bookings, back-to-backs with no gap, meetings with no agenda or prep, meetings
  outside the working hours they gave;
- the shared drives Curia's Google account can see, if any (§10).

It presents three or four findings at the end of the conversation, each a fact with an offer
("want me to…?"). Accepted offers run under the band just chosen: the principal's first approvals.
It writes nothing durable and is separate from the 90-day deep dive (#2362).

**Later sessions,** each a section of the playbook:

- **Review** (content from #2362): booked when the drafts are ready, in the format chosen. *Call:*
  park a review agenda walking the drafts. *Alone:* at the event, message that the drafts are
  ready and Curia is available. Done when it has happened, however much the principal approved.
- **Check-ins:** built from activity since the last session (triage, unsent drafts, approvals,
  corrections).
- **Ongoing rhythm** (the last subtask): Curia proposes a weekly session and the principal picks a
  cadence or none. If they choose one, it's a recurring event plus a scheduler job that, shortly
  before each occurrence, parks that occurrence's agenda from the playbook's *Weekly* section and
  the week's activity: independence (a proposed band change with evidence), feature upkeep, new
  plays, priorities.

### 10. Drives and imports

**Drives.** When onboarding starts, if Curia's Google Workspace account is signed in (#2683), Curia
lists the shared drives and top-level folders it can see (`list_drive_items`,
`resource_type: shared_drives`). Names and structure only; no file contents. The topic says what it
sees ("4 shared drives, including Executive") and asks: go deep on specific ones, take a general
pass like a new hire would, or leave them alone. Curia only sees drives its own account belongs to;
if the principal wants one it can't see, Curia says how to share it.

- The map (drives, top-level folders, what each seems to be for) is a durable document plus a few
  knowledge-graph facts, so later "where's the board deck?" questions find it. Not pinned context.
  Path: builder's call.
- A chosen pass becomes its own task, run async.

**Imports.** "Email me contacts, notes or writing samples any time." Each becomes its own task
handled with existing tools (`email-download-attachment`, `archive-extract`, `file-parse`,
`contact-create`, `doc-write`, `executive-profile-update`), and Curia reports what it filed.

### 11. `notifyOperator` placeholder

One function, `notifyOperator(event, details)`, called where the operator would need to act:
`greeting_unanswered`, `invitation_expired`, `web_search_failed`, `mailbox_signin_blocked` (with
the client id to mark trusted for an admin block). It records a progress note on the onboarding
task, logs at warn and writes an audit row.
`// TODO(#2365): deliver to the operator once the operator role exists.` When Setup's "Who it's
for" is Myself, Curia tells the principal directly in the conversation instead.

### 12. The contract with the deep dive (#2362)

#2362 is built after this issue, ships in the same release, and builds to this contract:

- **Trigger.** The onboarding subscriber for `principal_mailbox.connected` starts the deep dive.
- **Drafts ready.** The deep dive adds a progress note to the onboarding task's *Review* subtask
  listing the three drafts (title and Google Doc link each) and wakes the task. That wake books the
  review in the format the principal chose.
- **Outcome.** As each draft is reviewed, the review records it on the *Review* subtask as
  confirmed, corrected or set aside (#2362 writes confirmed content into Curia). The subtask is
  done once the review has happened.

A comment on #2362 points its builder here.

### 13. Done

The onboarding task completes when every subtask is done (completed or declined, in any order).
The last default subtask is the ongoing-rhythm conversation, which can end with no weekly session.

## Constraints

- **ADR-046 / prompt budget:** onboarding guidance lives in the `onboarding` skill, activated only
  for onboarding turns; the coordinator's always-on prompt doesn't grow.
- **Voice tool list is fixed:** voice applies choices through `async-offramp`.
- **Autonomy:** new tools declare `action_risk`; band-setting stays principal-authorized; only 65,
  75 and 85 are settable while an onboarding task is open.
- **Fail-safe defaults:** missing hold = triage on (existing installs); missing playbook = seeded
  on Start; onboarding never starts on its own; unconfirmed research never reaches memory.
- **Public repo:** fixtures and tests use synthetic principals.
- **Testing, kept light:** unit tests only for the rules that must always hold (the triage hold,
  the band limit, never starting on its own, no-show detection, the agenda following a moved
  event). The conversation is the model's job. Scenario cases are written for: the first
  conversation by chat; by voice (minutes follow-up); a deferral to a named day; a no-show; a vague
  "later". They run only with the maintainer's agreement and a cost estimate.

## Acceptance criteria changes to propose on #2360

- The plan fixture under `/meetings/` → the playbook, seeded to `/meetings/onboarding/playbook.md`
  at Setup start, plus an onboarding task whose progress is *what's happened*.
- Chat session ending with minutes → chat applies choices live and records them on the task; idle
  sends one nudge then pauses. Minutes remain for voice.
- "The operator is told in the console" → `notifyOperator` placeholder (TODO #2365).
- "Follow-ups are capped by a config value (tested)" → capped by a code constant.
- "Done when drafts confirmed and a weekly session agreed" → done when every subtask is done; the
  last subtask agrees an ongoing rhythm, which may be none.
- Start onboarding on the last Setup step with "Not right now" (confirmed, wording per who it's
  for), and on the dashboard until pressed.
- Add: homework and the research brief; "tell me about yourself"; the fuller inbox topic; the first
  look; drives and imports; side requests as their own tasks; no-show detection for calendar-tied
  agendas; the three deferral scenarios.
- Trim test criteria that pin conversation details (fixture transcripts for each write) to the
  rule tests and scenario cases above.

## Left to the builder

- Playbook wording, topic ids, options, and the repo fixture path.
- The style-picks → `tone.style` / verbosity mapping (start from the four tone templates).
- Greeting, follow-up and "missed you" copy; constant values for follow-ups, idle nudge and no-show
  grace.
- Exact "working principal" signals for the Start warning.
- Whether Start restarts Curia to load the ceo-inbox agent, or Setup enables the capability (held)
  at Apply & restart.
- Where the drive map document lives.
- How the drafts-reminder job is built.
