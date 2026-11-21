# Onboarding program — design (#2360)

**Status:** Draft, 2026-11-20
**Issue:** #2360 (milestone v0.46 - Onboarding Journey)
**Builds on:** `docs/wip/2026-10-29-onboarding-journey-design.md` (Phase 2, the journey this
implements), `docs/wip/2026-10-30-onboarding-hawd-model.md` (A1, A4, A5), spec 18
**Depends on (all merged):** #2358 Setup page, #2359 calls load the parked agenda, #2361
mailbox sign-in and `principal_mailbox.connected`, #2341 phone app and the 48-hour invitation,
#2683 sign in as Curia (Google Workspace)
**Feeds:** #2362 deep dive (its drafts are what the review session walks through)

## Intent

Curia's positioning: *the only private personal agent designed to handle people and priorities
with the finesse they expect from an experienced EA.* Onboarding is the first test of that. The
principal is asking one question throughout: **"How much work will it take before I can trust
this thing to act for me?"**

So onboarding has to feel like a good EA's first week, not like configuring software:

- Curia reaches out first, briefly, and says who set it up.
- The first conversation is short, mostly multiple choice, and Curia says back what it heard.
- Before the first conversation ends, Curia shows it has already understood something real about
  the principal's week (the **first look**). That is the moment that answers the trust question.
- Nothing visible happens to the principal's inbox or calendar that they weren't told about.
- Everything after that is a session the principal agreed to, booked on their calendar, ending in
  a weekly session that keeps tuning Curia's independence.

The journey design already covers the *what*. This document covers how it's built on what Curia
already has, and the refinements agreed on 2026-11-20.

## What changed from the journey design and the issue

Agreed with the maintainer on 2026-11-20:

1. **Onboarding is one ordinary task with subtasks**, not a separate plan document plus a chat
   session engine. The task's progress is *what's happened*.
2. **The playbook is an OKF document the operator can edit** (`/meetings/onboarding/playbook.md`),
   seeded from a repo default when Setup begins and **never refreshed** afterwards. It is *what to
   cover*.
3. **Chat sessions need no session machinery.** The coordinator works the open subtasks in the
   principal's thread. Voice keeps the parked agenda → minutes → follow-up path.
4. **A "first look"** closes the first conversation: last week's email and next week's calendar,
   read-only, three or four findings each with an offer.
5. **Drives and imports** become one short topic: what Curia's Google account can see, how deep to
   go, and "email me anything".
6. **Side requests** during onboarding (research a trip, file an import) become their own tasks,
   handled async; the conversation returns to the agenda.
7. **The last Setup step offers "Start onboarding" or "Not right now".** "Not right now" opens the
   full console; a dashboard alert keeps a Start onboarding button until it's pressed.
8. **No operator notification system.** A `notifyOperator` placeholder records the event; real
   delivery waits for the operator role (#2365). A solo executive is told in the conversation.
9. **Operator chat between Setup and Start is treated as the principal's** (as all console chat
   is today). Accepted until the console has identified logins.

## Goals

1. The operator starts onboarding when they choose, from Setup or later from the dashboard.
2. Curia greets the principal on the operator's chosen route and invites a ~20-minute first
   conversation by voice or chat; follow-ups are capped.
3. The first conversation runs end to end **by chat or by voice** from the same playbook: style,
   autonomy, standing preferences, connect email and calendar, what to expect, drives and imports,
   review format, the first look, and the next session.
4. Every choice is applied **while the principal is present**, read back, and recorded.
5. Email triage stays off until the principal has heard "what to expect", then switches on
   without a restart.
6. Later sessions (review, check-ins, weekly) are booked one at a time on the principal's
   calendar, and the agenda follows the event.
7. Onboarding is **done** when the principal has confirmed the deep-dive drafts (#2362) and agreed
   a weekly session.

## Non-goals

- An operator role, operator notifications, or operator identity in the console (#2365).
- Bulk import tooling (CSV or vCard contacts, writing-sample ingestion). Imports use existing
  tools this milestone.
- Refreshing a seeded playbook when the repo default changes.
- Curia calling out or joining Meet (#2231). Microsoft 365 principals.
- The deep dive itself and its inference heuristics (#2362). This issue books and runs the review
  session; #2362 supplies what it reviews.
- Calendar webhooks. Curia re-reads the event when it needs it.

## Anti-goals (failure even if it technically works)

- **A questionnaire.** Open prompts, scores, or more than a few questions without a read-back.
- **Visible surprises.** Mail labelled or archived, holds placed, drafts piling up before the
  principal was told.
- **A first look that lectures.** Advice about how the principal runs their week, or a wrong
  inference stated as fact. Findings are facts with offers.
- **Session spam.** Any session the principal didn't agree to; more than one booked at a time.
- **Onboarding hijacking the relationship.** A side request refused or deferred "until we finish
  onboarding".
- **Prompt sprawl.** Onboarding guidance in the coordinator's always-on prompt (ADR-046; the
  prompt-budget test).
- **Pulling existing installs in.** Prod and other running installs never get a greeting or a
  triage change unless someone starts onboarding.

## Approaches considered

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| **A** | **One onboarding task with subtasks, from an editable playbook.** An `onboarding` skill (active only while the task is) tells the coordinator how to run it. Chat works the subtasks live; voice parks an agenda built from the open subtasks. | Reuses tasks, agendas, minutes and live-turn authority. The plan is a task list plus a playbook doc rather than one plan document. | **Chosen** |
| B | The issue as written: make the agenda tool work in chat, add a chat-session lifecycle (start, idle timeout, end), produce minutes from chat transcripts, keep a separate plan document. | One agenda mechanism for both routes, but it builds a chat-session runtime Curia has never had (the #2364 spike never ran) and roughly doubles the size. | Rejected |
| C | A dedicated onboarding agent owning the principal's thread, like the setup guide. | Clean prompt isolation, but the principal talks to a different agent than the one they'll use daily; side requests need a hand-back; voice still reaches the coordinator. | Rejected |

## Design

### 1. Parts and where they live

| Part | What it is | Where |
|---|---|---|
| **Playbook default** | Markdown: one `#` section per session type, one `##` subsection per topic | repo fixture, e.g. `config/onboarding/playbook.md` (builder's call on path) |
| **Playbook** | The install's copy, editable by the operator or principal in Documents | OKF `/meetings/onboarding/playbook.md` (durable prefix) |
| **Onboarding task** | Parent task, owner `curia`, one subtask per topic of the current session; progress notes are *what's happened* | `tasks` table, tagged `onboarding` |
| **`onboarding` skill bundle** | How Curia runs onboarding (the rules in §5), plus the few tools onboarding needs | `skills/onboarding/` |
| **Code guarantees** | Triage hold, allowed autonomy bands, never-start-on-its-own | `src/onboarding/` |

The skill holds *how Curia behaves*; it is fixed and ships with the code. The playbook holds
*what to cover*; it is the operator's to tailor. Nothing that must always hold lives in the
playbook: deleting a topic can only leave something off.

**Playbook format.** Each topic subsection has a stable id in a short HTML comment or heading
suffix (builder's call), a one-line goal, suggested questions with options, and whether it needs
the mailbox. Example:

```markdown
# First conversation

## Style  <!-- topic: style -->
Goal: how Curia talks to the principal.
- Chatty and thorough, or brief and to the point?
- Dry, or a bit of humour?
- Warm and personable, or crisp and businesslike?
- When I'm not sure: ask, or make a sensible call and tell you?
Read back a two-line sample in the chosen style; one round of tweaks.
```

### 2. Seeding the playbook

When Setup begins (`POST /api/setup/start`, which already runs only on a fresh database), Curia
copies the repo default to `/meetings/onboarding/playbook.md` if no doc exists at that path. It is
never overwritten afterwards. An install that predates Setup has no playbook until someone starts
onboarding, which seeds it the same way.

### 3. Starting onboarding

**Where.** The last Setup step becomes a choice:

- **Start onboarding.** Starts now (below), then opens the console.
- **Not right now.** Ends Setup (phase complete, as today) without starting onboarding, and opens
  the full console. The web thread is not rotated yet (see step 5). The operator can explore,
  configure Curia, and edit the playbook. Their chat in this stretch is treated as the
  principal's, like all console chat today; accepted until the console has identified logins.

Until onboarding has started, the console dashboard shows an alert — "Onboarding hasn't started.
Start when <principal> is ready." — with a **Start onboarding** button. The alert shows only on an
install whose Setup was finished on the Setup page (`setup_state.completed_at` set by the page,
not by migration 130), so prod and other pre-Setup installs never see it.

**What Start does** (one server route, idempotent, refuses a second start):

1. **Warn on a working principal.** If the install already looks in use — the Email triage
   capability is on, or the principal has tasks or conversation history from before Setup
   completed — the console asks for confirmation first. (Exact signals: builder's call, from what
   migration 130 and `startSetup` already test.)
2. **Hold triage** (§7).
3. **Seed the playbook** if missing (§2).
4. **Create the onboarding task** with one subtask per *First conversation* topic.
5. **Rotate the web thread** so the principal's first view is clean. (Today this happens when
   Setup completes; it moves here, so an operator who chose "Not right now" keeps their thread
   until Start.)
6. **Reach the principal** on the messaging route from Setup:
   - **Curia app:** mint the 48-hour invitation (existing `pairing-invitations`) and show it in the
     console with copyable wording that mentions the 48 hours. The existing invitation panel is
     reused. The greeting goes out when the invitation is redeemed: redemption publishes a new
     bus event (none exists today) that an onboarding subscriber turns into a task wake. If the
     invitation expires unredeemed, Curia calls `notifyOperator('invitation_expired')` and the
     console's invitation panel shows it expired with its existing "new link" action; onboarding
     waits. Follow-ups (§4) start only once Curia has a channel to the principal.
   - **Signal, SMS, Slack:** check Curia can reach the principal's id on that route (for Slack, a
     DM to the member id), then send the greeting as the hello. The console shows what was sent.
   - No email invitation.
7. **Solo executive** (Setup's "Myself"): the wording says the invitation is for them, and Curia
   offers to start the first conversation right there in the console.

**A principal can also ask** ("can we do the onboarding?") — the coordinator calls the same start
path through an `onboarding-start` tool. Nothing else starts onboarding; a test covers an install
that reaches `setup_complete` with nobody pressing Start.

### 4. The greeting and follow-ups

The greeting, in the principal's channel:

- who Curia is (name from Setup) and who set it up (the operator's name, or "you" when solo);
- a ~20-minute first conversation to learn how they like to work;
- how to do it by chat (just reply) or voice (tap to call, or call on Signal);
- nothing else.

If there's no reply, the onboarding task's wake time sends a follow-up. The number of follow-ups
and the gap between them are config values (`onboarding.greeting_followups`,
`onboarding.greeting_followup_hours`; defaults 2 and 48h, builder's call). After the last one,
Curia stops and calls `notifyOperator('greeting_unanswered')` (§10). Ad-hoc chat works throughout.

### 5. Running a session

**How a turn picks up onboarding.** Task wakes (greeting follow-ups, nudges, the connected event,
session bookings) are task-bound turns, so they restore the `onboarding` skill from the task's
active skills, as the minutes follow-up does for `meetings`. An ordinary inbound message from the
principal carries no task id, so it would not. **Trigger-time injection** (ADR-046's second rung)
covers that: while an onboarding task is open, a principal turn on any channel (and the voice
`async-offramp` hand-off) gets the `onboarding` skill activated plus a short injected block naming
the onboarding task id and its open subtasks for the current session. The turn is not bound to the
task, so a side request in the same message is handled as a normal coordinator turn; the skill's
rules tell Curia to split it into its own task. Nothing is added to the always-on prompt. Any
other principal turn, when no onboarding task is open, is unchanged.

**The `onboarding` skill**'s rules:

- Work the open subtasks of the current session in playbook order, one at a time.
- Ask mostly multiple choice, as numbered options with "something else" as the escape. Read back
  what was heard after each topic.
- **Apply each choice as soon as it's confirmed**, with the tools in §6, and tick the subtask.
- **Side requests** (a trip to research, a file to import, a question about a meeting): create a
  separate task, hand it to the right agent async, say when to expect it, and return to the
  agenda. Never "after onboarding".
- If the principal stops ("let's pick this up later"), record where things stand, ask when to
  continue, and book that (§8).
- Topics that need the mailbox wait until it's connected; the rest carry on.

**Chat.** The coordinator runs the session in the principal's thread. A principal's chat turn is
already a live principal turn, so principal-authorized writes (autonomy, tone, triage) apply
without an approval prompt. When the principal goes quiet mid-session, the task's wake time sends
one nudge after an idle period (config, builder's default); after that the session is simply
paused and the open subtasks carry to the next one.

**Voice.** Before a voice session, Curia parks an agenda (`meeting-agenda-park`) built from the
open subtasks and the playbook text, with the onboarding task id in its context. The call loads
it (#2359). During the call, choices are applied through `async-offramp` with a live-turn grant
(#2495), so they take effect while the principal is on the line; the voice tool list doesn't
change. After the call, the existing minutes follow-up (meetings bundle) ticks the subtasks the
minutes show as covered and applies anything still outstanding; a write that lost its live grant
becomes a confirmation request, as it does today.

Either route can follow the other: a principal can start by voice and finish in chat.

### 6. First conversation topics and the writes behind them

| Topic | Asks | Applies | Through |
|---|---|---|---|
| Hello | — | — | — |
| Style | Paired choices (§1 example) | `tone.style`, `tone.verbosity`, read back with a sample | **new** `office-tone-update` tool (no agent can write tone today) |
| Autonomy | Draft only (65), Ask first (75, recommended), Spot-check (85) | autonomy score | `set-autonomy`, constrained to those three values while the onboarding task is open (code) |
| Standing preferences | Urgent vs routine contact; quiet hours; **working hours**; daily recap and time; unsent-drafts reminder | `behavioralPreferences`; recap and drafts-reminder jobs | `behavioral-preferences-update`; `scheduler-create` (`daily_debrief` anchor for the recap; a new drafts-reminder job) |
| Connect email and calendar | Why; the sign-in link | grant | `mailbox-signin-link` (pinned to the onboarding skill too); if a mailbox is already connected, confirm which account instead |
| What to expect | Built from current settings: labelling and archiving and where mail goes, holds, booking at the chosen band, drafts as agreed | **triage released** (§7) | `onboarding-triage-release` |
| Spoken voice | One line: it can be changed under Behaviour → Personality | — | — |
| Drives and imports | What Curia's Google account can see; how deep to go; "email me anything" | drive map; follow-up tasks | §9 |
| Review format | Call together, or review alone then text | recorded on the task | task progress note |
| First look | (Curia shows; §8a) | offers, each its own action under the chosen band | existing calendar and ceo-inbox tools |
| Next step | When to do the review (booked once drafts are ready); how often to check in | the next session | §8 |

**Working style from Setup.** If the operator picked a tone or independence level in Setup
(identity history `changedBy: 'working_style'`, the autonomy history equivalent), the Style and
Autonomy topics present it as the current setting and ask keep-or-change, rather than asking from
scratch.

**"Couldn't connect yet."** If the sign-in fails or is abandoned (`admin_blocked`, `org_internal`,
wrong account, partial grant, cancelled), Curia says why in plain words, calls
`notifyOperator('mailbox_signin_blocked', { outcome, clientId })`, leaves the subtask open, and
carries on. What to expect and the first look wait. When `principal_mailbox.connected` arrives
later, an onboarding subscriber wakes the task: Curia resumes the connect step and what to expect
in the next session or by message.

### 7. The triage hold

Agents load only at startup, so switching the Email triage capability on mid-conversation would
need a restart. Instead:

- **Start onboarding turns the Email triage capability on in the registry and sets a hold**
  (config-store key `onboarding/triage_hold`, a new key; **not** `ceo_inbox/triage`, which holds
  the per-mailbox cadences). Registry changes apply at the next restart; Start onboarding doesn't
  restart, so the builder decides whether Start triggers a restart or Setup's Apply & restart
  already carries it (the capability can be enabled-but-held from Setup onward). See open
  question in *Left to the builder*.
- **While the hold is set,** the inbox heartbeat, `inbox-drain` and the ceo-inbox crons
  (sent-observe, voice-learn) do nothing that touches the principal's mailbox: no labels, archives,
  drafts or sends. Enforced in code at the heartbeat and in the ceo-inbox mailbox-writing tools.
- **"What to expect" releases it** through `onboarding-triage-release` (principal-authorized,
  `action_risk: low`, refuses unless the What to expect subtask is complete). Live, no restart.
- **A missing hold means no hold,** so existing installs keep triaging when this ships.
- Capabilities shows Email triage as "Held until <principal> hears what to expect" while held.
  The principal can still switch the capability off later in Settings, and switching it on there
  clears the hold (an explicit choice in Settings outranks the onboarding gate).
- **If onboarding stalls, the hold stays.** A principal who never replies keeps triage off with no
  end date. That is the safe state: nothing touches a mailbox nobody has been told about.
- **Cancelling.** The principal can say "stop the onboarding", and the onboarding task can be
  cancelled from the console's task view. Cancelling leaves the hold in place (triage stays off
  until the principal or operator turns it on in Settings) and records why on the task. Start
  onboarding can run again after a cancel; it creates a new task and reuses the playbook as is.
  "Refuses a second start" means while an onboarding task is open.

### 8. Sessions on the calendar

**Booking.** At the end of each session the principal and Curia agree the next one, and only that
one is booked:

- **Calendar connected:** a busy event on the principal's calendar, the principal the only
  attendee, titled for the session ("Review Curia's drafts — call Curia"). Booking was agreed in
  the session, so if the band requires approval for a calendar write the principal gets the one
  prompt they were told about. The event id is stored on the onboarding subtask and on the parked
  agenda.
- **No calendar yet:** a scheduler job at the agreed time plus the nudge; it becomes an event once
  the calendar connects.

**The agenda follows the event.** No webhooks: before each nudge, pre-session delivery or agenda
park, Curia re-reads the event by id.

- **Moved:** reschedule the nudge, the delivery and the agenda's `scheduled_for`.
- **Cancelled or deleted:** ask once when to do it instead, and book the answer.
- **Late:** an agenda tied to an event stays loadable until it's done or replaced, instead of the
  ±12h `isDue` window (agenda frontmatter gains the event id; `isDue` treats event-tied agendas as
  due from 12h before the event until settled). `expires_at` still bounds it.

**8a. The first look.** As soon as the mailbox is connected — at the start of the first
conversation if it was connected in Setup, otherwise when `principal_mailbox.connected` arrives —
Curia runs a background read, bounded to **the last 7 days of email and the next 7 days of
calendar**:

- email: threads waiting on the principal for more than a day or two; anything that looks urgent;
- calendar: double-bookings, back-to-backs with no gap, meetings with no agenda or prep, meetings
  outside the working hours they just gave;
- if Curia's Google account sees shared drives: their names (from §9).

It presents three or four findings at the end of the conversation, each a fact with an offer
("want me to…?"). Accepted offers run under the band just chosen, so they are the principal's first
approvals. It writes nothing durable and is separate from the 90-day deep dive (#2362).

**Later sessions.**

- **Review** (content from #2362): booked when the drafts are ready, in the format chosen.
  *Call:* park a review agenda walking the drafts. *Alone:* at the event, message that the drafts
  are ready and Curia is available.
- **Check-ins:** built from activity since the last session (triage, unsent drafts, approvals,
  corrections). When corrections settle, Curia proposes the weekly session.
- **Weekly:** a recurring event plus a scheduler job that, shortly before each occurrence,
  generates and parks that week's agenda from the playbook's *Weekly* section and the week's
  activity: independence (with a proposed band change and evidence), feature upkeep, new plays,
  priorities. If the occurrence moved or was skipped, the job follows it.

### 9. Drives and imports

**Drives.** When onboarding starts, if Curia's Google Workspace account is signed in (#2683), Curia
lists the shared drives and top-level folders it can see (`list_drive_items`,
`resource_type: shared_drives`). Names and structure only; no file contents. The topic says what
it sees ("4 shared drives, including Executive") and asks: go deep on specific ones, take a
general pass like a new hire would, or leave them alone. Curia can only see drives its own account
is a member of; if the principal wants one it can't see, Curia says how to share it.

- The map (drives, top-level folders, what each seems to be for) is written as a durable document
  and summarised into a few knowledge-graph facts so later "where's the board deck?" questions
  find it. Not pinned context (prompt budget). Path: builder's call, under a durable prefix.
- A chosen pass becomes its own task, run async.

**Imports.** "Email me contacts, notes or writing samples any time." Each email becomes its own
task handled with existing tools (`email-download-attachment`, `archive-extract`, `file-parse`,
`contact-create`, `doc-write`, `executive-profile-update`), and Curia reports what it filed.
Bulk import tooling is out of scope.

### 10. `notifyOperator` placeholder

One function, `notifyOperator(event, details)`, called where the operator would need to act:
`greeting_unanswered`, `invitation_expired`, `mailbox_signin_blocked` (with the client id to mark
trusted for an admin block). It records a progress note on the onboarding task, logs at warn, and writes an audit row.
`// TODO(#2365): deliver to the operator once the operator role exists.` When Setup's "Who it's
for" is Myself, Curia tells the principal directly in the conversation instead.

### 11. The contract with the deep dive (#2362)

#2362 is built after this issue and builds to this contract, so this issue defines it. The two
are **released together** (maintainer, 2026-11-20): no install runs one without the other, so there
is no fallback path for a missing deep dive.

- **Trigger.** The onboarding subscriber for `principal_mailbox.connected` starts the deep dive
  (the job itself is #2362's; until it exists the subscriber does nothing for it).
- **Drafts ready.** The deep dive adds a progress note to the onboarding task's *Review* subtask
  listing the three drafts (title and Google Doc link each) and wakes the task. That wake books
  the review session in the format the principal chose (§8).
- **Confirmed.** Confirmation is per document: the review records `rules`, `priorities` and
  `voice` as confirmed on the Review subtask as each is written into Curia (#2362 does the
  writing). The Review subtask completes when all three are confirmed or explicitly dropped.

### 12. Done

The onboarding task completes when the principal has confirmed the deep-dive drafts (#2362) and
agreed a weekly session. Until #2362 ships, the review subtask stays open.

## Constraints

- **ADR-046 / prompt budget:** onboarding guidance lives in the `onboarding` skill, activated only
  for onboarding turns; the coordinator's always-on prompt doesn't grow.
- **Voice tool list is fixed:** voice applies choices through `async-offramp`; no new voice tools.
- **Autonomy:** new tools declare `action_risk`; band-setting stays principal-authorized; only 65,
  75 and 85 are settable during onboarding.
- **Fail-safe defaults:** missing hold = triage on (existing installs); missing playbook = seeded
  on Start; onboarding never starts on its own.
- **Public repo:** fixtures and tests use synthetic principals.
- **Paid tests:** unit and integration tests during development; scenario cases written for the
  first conversation by chat and by voice-minutes, run only with the maintainer's agreement.

## Acceptance criteria changes to propose on #2360

- "The plan fixture… copied to one plan per principal under `/meetings/`" → the playbook fixture
  seeded to `/meetings/onboarding/playbook.md` at Setup start, plus an onboarding task whose
  progress is *what's happened*.
- Chat session ending "on completion, on the principal's word, or on idle timeout, and minutes are
  produced in each case" → chat is task-driven: choices are applied live and recorded on the task;
  idle sends one nudge then pauses. Minutes remain for voice.
- "The operator is told in the console" → `notifyOperator` placeholder (TODO #2365).
- Start onboarding is offered on the last Setup step with "Not right now", and on the dashboard
  until pressed.
- Add: the first look; drives and imports topic; side requests become their own tasks.

## Left to the builder

- Playbook wording, topic ids, options, and the repo fixture path.
- The style-picks → `tone.style` / verbosity mapping (start from the four tone templates).
- Greeting and follow-up copy; follow-up count, gap and chat idle timeout defaults.
- Exact "working principal" signals for the Start warning.
- **Triage hold and the registry:** whether Start onboarding restarts Curia to load the ceo-inbox
  agent, or Setup enables the capability (held) at Apply & restart so no restart is needed later.
- Where the drive map document lives.
- How the drafts-reminder job is built (a scheduled task listing unsent drafts and messaging the
  principal).
