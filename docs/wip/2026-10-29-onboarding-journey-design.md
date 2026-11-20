# Getting started: Setup, then Onboarding — design

**Status:** Draft, 2026-10-29; revised 2026-11-01 after principal and operator feedback (see
*What changed in this revision*); Phase 1 rewritten 2026-11-19 to match the Setup page (#2358)
**Scope:** how people get started with Curia, end to end: the operator's setup, the principal's
onboarding, the docs that describe both, and the setup tooling
**Related:**
- ADR-055 (PWA, #2341)
- spec 18 (onboarding), spec 13 (office identity), spec 14 (autonomy)
- `docs/wip/2026-10-26-agenda-minutes-voice-shim-design.md` (agenda and minutes architecture;
  first slice #2322)
- #2338 (`pinned_context`)
- `docs/wip/2026-10-30-onboarding-hawd-model.md`: the same journey modelled from the principal's
  side in HAWD notation

## What changed in this revision

Feedback from a principal and from operators changed the journey in five ways:

1. **Two phases, two people, no overlap.** Getting started is **Setup** (the operator) and then
   **Onboarding** (the principal). The operator decides and connects every channel before the
   principal hears anything. The principal is never asked to set up voice or pick a messaging
   app. "Give Curia a desk" is retired.
2. **The operator says "go", then Curia reaches out first.** When Setup is complete and the
   operator is ready, they start onboarding from the console and send the principal an
   invitation link through whatever channel they normally use with them. The principal's first
   experience of Curia itself is Curia greeting them and inviting them to a first conversation.
3. **One first conversation, by voice or chat, mostly multiple choice.** It sets Curia's working
   style and autonomy, gives "what to expect", has the principal connect their own email and
   calendar through a sign-in link, and asks how they'd like to review what Curia drafts.
   Chat is now a first-class route, not a spike.
4. **The deep dive also learns the principal's writing voice,** and its drafts are delivered as
   Google Docs with one email and a review session on the principal's calendar. The review adapts
   to the format the principal chose. Sessions are real calendar events, and their agendas follow
   them when the principal moves them.
5. **Onboarding ends in a weekly session** that keeps tuning Curia's independence and finding
   new uses for it.

Operators also told us they didn't know what to expect or how to get set up. The curia-docs
"Getting started" section is restructured around the two phases (*How the docs tell it*).

## Why

Curia is built for an executive, and much of its value comes from working across channels: it
has its own email, it messages the principal, and it holds a real conversation by voice. Today's
getting-started story hides that:

- Every surface says the only requirement is Docker plus an Anthropic key.
- Every channel is optional.
- The setup-wizard agent opens with "instant wins first — no credentials needed", then mixes
  operator work (credentials, channels) with the principal's (tone, priorities).

Operators finish an install that "works" but never shows the product, and don't know what comes
next. Principals who are reached at all meet a technical setup conversation that isn't theirs to
have.

The end state:

- The operator follows one clear Setup path and knows when they're done.
- The principal's first contact is Curia introducing itself. Within one conversation they've
  shaped how Curia works with them and connected their email and calendar.
- A few days later Curia shows them drafts of their working rules, priorities and writing voice,
  drawn from their own history, and they confirm them.
- From then on a weekly session keeps tuning Curia's independence and finding it more to do.

## Two phases, two people

**Getting started has two phases: Setup (the operator) and Onboarding (the principal).**

| | Setup | Onboarding |
|---|---|---|
| **Who** | The **operator**: whoever installs and runs Curia (an EA, IT, a technical friend, or the principal themselves) | The **principal**: the executive Curia works for |
| **What** | Install Curia, then connect its channels and services, and make the decisions that come with them | Shape how Curia works with them, connect their own email and calendar, confirm what Curia learns, then keep tuning |
| **Where** | The installer, the console's Setup page, the setup guide beside it | Conversations with Curia (voice or chat), Google Docs, email |
| **Done when** | Every required Setup step is complete and verified, and the operator presses Start onboarding | The principal has confirmed the deep-dive drafts and agreed a weekly session |

**Terminology.**
- *Setup* is the operator's phase, matching the code that carries the name (the console's Setup
  page at `/setup`, the setup agent, `setup-status` and its catalog).
- *Getting started* is the umbrella, matching curia-docs' existing `get-started/` section.
- *Deployment* keeps its narrower meaning in the docs: server topology and self-hosting
  (`get-started/deployment.mdx`), one step inside Setup.
- "Desk" is retired from user-facing wording and from this design.

**The solo executive.** When the principal sets Curia up themselves, operator and principal are
the same person. They still go through both phases in order: Setup first, then Curia invites
them to Onboarding.

**The line between them.** Nothing in Setup asks for the principal's preferences, and nothing in
Onboarding asks the principal to configure infrastructure. The single crossing point is the
principal's own sign-in to their mailbox, which only they can consent to, and which the operator
has made a one-click step during Setup.

## Goals

1. **One clear Setup path for operators,** with honest time and cost estimates and a clear
   "you're done" moment. The docs, README, website, installers and setup agent all tell the same
   story.
2. **Onboarding is a conversation, not a form.** Curia runs it: it invites the principal, holds
   the first conversation by voice or chat, and books each next step with them.
3. **Mostly multiple choice.** The principal picks from described options; they don't write
   freeform answers or enter scores. Curia turns their picks into settings and reads the result
   back.
4. **Reach the "aha" moment.** Curia infers the principal's working rules, priorities and writing
   voice from their own history, the principal confirms them, and Curia works against them.
5. **An onboarding that keeps going.** Check-ins taper into a weekly session that tunes autonomy
   and features and finds new plays.
6. **Fix the setup-doc inconsistencies** found during research (Appendix A).

## Non-goals

- **Google Meet or Curia-initiated calls.** Curia joining a booked call (#2231) is nice-to-have.
  Voice sessions use the existing pattern: the agenda is parked, Curia nudges, and the principal
  calls in.
- **Requiring Signal or SMS.** They remain alternative messaging routes. Requiring a phone number
  is exactly the barrier the PWA exists to remove (ADR-055).
- **Priorities in specialist agents.** ceo-inbox and calendar do not pin the priorities document
  in this milestone (see *Priorities: scope*).
- **An operator role in the identity model.** Still a design issue only (#2365). The operator is
  addressed through Setup surfaces (console, setup agent), not as a contact Curia routes to.
- **Principals on Microsoft 365.** This milestone supports principals with a Google account
  only: the drafts are Google Docs, and the mailbox sign-in uses a Google connector. Microsoft is
  a follow-up (mailbox sign-in, and a review route that doesn't need a Google account).
- **Google Docs as the long-term home** of priorities, rules or writing voice. Docs are where
  drafts are reviewed; the Curia app is where confirmed versions live.

## Anti-goals (failure even if it technically works)

- **A requirements list that reads like a wall.** If the docs leave an executive thinking "I
  need six API keys before I can try this", we've failed, even if every key is correct.
- **Setup bleeding into Onboarding,** or the reverse. The principal is asked to configure a
  channel or fetch a key; or the operator is asked about the principal's tone or autonomy.
- **A questionnaire.** Open-ended prompts ("describe your ideal assistant"), scores ("rate
  1–10"), or more than a handful of questions in a row without Curia saying back what it heard.
- **Ad-hoc session spam.** Every follow-up session is one the principal agreed to. Curia doesn't
  improvise a meeting every time it has a question.
- **Acting on inferred priorities, rules or voice before the principal confirms them.** They
  stay drafts until then.
- **Visible changes the principal didn't expect.** Mail labelled and leaving the inbox, holds or
  moves on the calendar, and drafts sitting unsent all read as broken, not helpful, to someone
  who wasn't told they were coming.
- **Context sprawl.** Priorities are pinned where they clearly pay off (the coordinator, voice,
  the recap), not everywhere they might help.

## Phase 1 — Setup (the operator)

> **Rewritten 2026-11-19 (#2358),** to match what shipped. The `/setup` form and the setup
> checklist became one **Setup page** in the console, with the setup agent as a help panel
> beside it and a Capabilities page. Spec 18 (*Setup page*) has the routes and the details;
> this section keeps the design. Mockup:
> [`setup-page-mockup.html`](2026-10-29-onboarding-journey-design/setup-page-mockup.html).

### 1a. Install (~5 minutes)

What's needed: Docker with Compose, an LLM key, and **a domain or HTTPS route** to the host.

HTTPS is a stated requirement: the PWA installs only on a trusted HTTPS origin (ADR-055 §1), and
the principal's mailbox sign-in needs an HTTPS callback (see *1b*). The installer already asks
the topology question (local, domain or proxy). The local option stays, labelled try-out only.
LiveKit, which voice runs on, comes with the install; seeding its keys there is #2689.

### 1b. The Setup page (~1–2 hours, at the operator's pace; can span days)

A new install's console opens on the Setup page, and stays there until **Start onboarding**:
every page but Setup and the Settings pages it may need redirects to it. An install that
predates it never sees it. The page is a step list on the left and the open step on the right;
any step can be opened, and **Save and continue** walks them in order. Every field a step needs
is on the step, so the operator never has to leave Setup. Fields save when the operator leaves
them; there is one button per step.

| Step | Required | What the operator does | Done when |
|---|---|---|---|
| **Who it's for** | Yes | Myself or someone else; for someone else, their own name and email; the principal's name, title, email, timezone and pronouns | The principal's basics are saved |
| **Curia's name** | Yes | Name, title and email signature (a first name is suggested) | Saved from the console |
| **Email** (Curia's own) | Yes | The Nylas API key, then Connect with Google for Curia's mailbox, or a pasted grant ID | The email channel's key and mailbox are in, and it is on |
| **Messaging** | Yes | One route: the Curia app (PWA, default), Signal, text message (Telnyx) or Slack, with that route's keys and the principal's id on it, linked to their contact. Nothing is sent to the principal | That route's check passes |
| **Voice** | Yes | The Curia app or a Signal call (Phone is shown as coming soon); the Deepgram and Cartesia keys and Curia's spoken voice | The voice route's check passes |
| **Email & calendar** (the principal's) | Yes | The same Nylas key, the sign-in checks, and Connect with Google for the principal when they're beside the operator | Sign-in is ready (the #2682 checks): the principal can connect in their first conversation |
| **Apply & restart** | — | One restart turns on everything saved, and every step is checked again | — |
| **Start onboarding** | — | Locked until every required step is done; lists what's left | Ends Setup (2.1) |

**Optional extras** follow, unnumbered, and never block Start onboarding:

- **Working style.** A tone (one of the four tone templates) and an independence level (Draft
  only, Ask first, Spot-check). Leave them and the defaults apply. Anything set is a starting
  point the principal is offered in the first conversation (2.2). Setting a tone doesn't count
  as naming Curia.
- **Google Workspace.** Curia's Google address and the OAuth client ID and secret. "Sign in as
  Curia" from the console is #2683; until then the guide covers it.
- **Higher search limit.** The Tavily key. Web search works without one, capped per hour.
- **Capabilities.** Switches for what Curia can do (see *Capabilities* below).

**"Ready" for messaging means ready for the principal,** not tested on them. The operator
can't pair the principal's phone, and Setup must not message the principal before the
invitation. So the Curia app route counts as done when HTTPS and push are working; the
principal installs the app from the invitation link (2.1). Signal, SMS and Slack count as done
when the channel is ready and the principal's id on it is linked to their contact. Phone
numbers are stored as E.164, since the channels compare them exactly.

**Why voice stays required** even though the principal can onboard by chat: the principal is
offered voice or chat for every session, and the offer has to be real. A principal who picks
voice must not be told it isn't set up.

**Channels start at Apply & restart.** A channel is turned on as soon as its required keys are
in, and starts when Curia restarts. The page tells the operator what else a channel needs when
it can't turn on (Voice: LiveKit's keys, from the install).

**Principal mailbox sign-in** replaces the hand-made grant. The principal grants access
themselves, during the first conversation, through a link Curia sends. For that to be one click
on the day, the operator must have done the provider work beforehand (Nylas and Google docs
checked 2026-11-01):

- **How the sign-in works** (Nylas v3 hosted authentication). Curia mints a single-use link to
  Nylas's `/v3/connect/auth` with a `state` token and a `login_hint` of the principal's address.
  The principal signs in with their provider; Nylas redirects to a callback on the Curia server;
  Curia exchanges the code for a grant id, writes it to the `principal_mailboxes` registry, and
  emits a one-time `principal_mailbox.connected` event (built in #2361). Curia's own mailbox
  uses the same flow and connector (Connect with Google on the Email step); its callback writes
  an `email_accounts` row instead, then restarts Curia. The callback must be reachable from the
  principal's phone, which is one more reason HTTPS is an install requirement.
- **No restart for the principal.** The principal is mid-conversation when the grant arrives,
  so the services that use it pick it up without the operator doing anything.
- **What the operator configures in Nylas:** an application (a Sandbox works for a single
  install: its built-in Google connector grants the scopes Curia needs, up to 5 accounts); a
  connector for the principal's provider, unless the Sandbox's built-in one is used; and Curia's
  callback, which the Email & calendar step registers from the API key on its first check. The
  client id is read from the application, and the region is detected.
- **Google.** The operator brings their own Google Cloud project and OAuth client (Nylas's
  shared Google app needs a paid annual plan). Curia needs `gmail.modify` and `gmail.compose`,
  which Google classes as *restricted*. Verifying an app for restricted scopes needs a paid
  security assessment, so for one executive the guide recommends, in order:
  1. **Principal on Google Workspace:** create the project inside the principal's organisation
     (their admin may need to) and set it to **Internal**. No verification, no warning screen.
  2. **Otherwise:** External, publishing status **In production**, left unverified under
     Google's personal-use allowance. The principal clicks through an "unverified app" screen
     once, and the guide and Curia both warn them it's coming.
  3. **Never "Testing" status:** refresh tokens expire after 7 days and the grant breaks weekly.

  Evidence so far (2026-11-17, see `2026-11-17-mailbox-sign-in-google-findings.md`): an External,
  In-production, unverified app holding a restricted scope kept working past 7 days. Still open:
  the same with the Gmail scopes, and whether a Workspace admin's controls on unconfigured apps
  would block it (the callback reports `admin_blocked` and `org_internal` with what to ask the
  admin).
- **Microsoft 365 (follow-up, not this milestone).** For the record: a multi-tenant app
  registration with delegated `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite` and
  `offline_access`; its client secret lasts at most 24 months and grants break when it expires;
  tenants that allow user consent only for verified publishers need the principal's admin to
  consent.
- **Cost.** A second Nylas account fits within Nylas's lower plans (from $15/month for 10
  accounts, checked 2026-11-01). Whether the free plan allows custom connectors is unverified.

The Email & calendar step counts as done when sign-in is ready, not when a grant exists: the
grant is the principal's to give.

**Google Docs access is optional in Setup.** The deep-dive drafts are delivered as Google Docs
(2.4), so a principal who will review that way needs it before then, but it doesn't block
Start onboarding: it became the Google Workspace extra, and its sign-in (#2683) isn't in the
console yet.

**Readiness.** One `setup_complete` flag (`src/setup/checklist.ts`, read by both the page and
the setup agent's `setup-status`) is true when every required step is done and verified, not
just configured. It doesn't start Onboarding by itself: it unlocks **Start onboarding**, and the
operator decides when to press it (2.1). There is no partial start and no "voice later" path:
until Setup is complete, the step stays locked and Curia doesn't contact the principal. Only
optional extras can be deferred.

### Capabilities

One list of switches, the last optional extra and **Settings → Behaviour → Capabilities**. Each
capability is a group of agents, skill bundles and tools from a small catalog, switched together
through the registry. Turning one on enables what it pins before its agents, and offers to turn
on the capabilities its agents need (Meeting debriefs and Email triage need Projects and tasks).
Turning one off disables its agents first; if an enabled agent outside it pins one of its
bundles, the operator is told which and can turn it off anyway, leaving that agent without
those tools:

| Capability | On a new install | In Setup |
|---|---|---|
| Meetings | On | Always on: the onboarding sessions run on it |
| Meeting debriefs | On | Switchable |
| Web research | On | Switchable |
| Projects and tasks | On | Switchable |
| Diagnostics | Off: it reads Curia's audit log and working records, so it's opt-in | Switchable |
| Email triage | Off | Locked: it acts on the principal's inbox, so it's theirs to choose (*Triage switch*) |

Turning one off names the other parts of Curia that use the same pieces and asks first; turning
one on also turns on what its agents need. Changes apply at the next restart: in Setup, at Apply
& restart.

### The setup guide

The setup agent is the operator's help panel through Setup, and only Setup. It never drives
Setup: the page does.

- **Where.** A full-height column docked to the right of the Setup page, on the console's own
  chat (no new chat components or endpoints). It opens by itself on a first run and is closed
  when an operator comes back. Each step's **Need help? Ask the setup guide** opens it with the
  step named in the composer, and a "Now on: <step>" line marks each step change. The open step
  goes with each message, and the agent reads it.
- **What it does.** It opens by acknowledging whether Curia is being set up for the operator or
  someone else (from Who it's for); explains options and trade-offs (which messaging route,
  Curia's name and spoken voice, which Google account Curia uses); troubleshoots with
  `setup-status`; never claims a step works without a live check; and ends by explaining Start
  onboarding and its link, valid for 48 hours, so the operator sends it when the principal can
  act on it. Someone setting Curia up for themselves is offered the first conversation straight
  away.
- **What it doesn't.** No "instant wins", persona capture, or anything about the principal's
  tone, autonomy or priorities: that is Onboarding's first conversation. It has no memory,
  preference, contact or scheduler write tools.

### Who the console is talking to

The console, and the phone app with it, shares one chat thread, and every console chat is
treated as the principal (`src/channels/http/routes/chat.ts`). That matches the journey: **during
Setup the console is the operator's, and afterwards it is the principal's.** No operator identity
is added (#2365 stays off the critical path). Three rules keep the hand-over clean:

- **Setup chat goes to the setup agent.** Opening the Setup page starts Setup, so from the
  first message web chat goes to the setup agent, decided on the server. A database whose
  principal a script created never starts it, and keeps the coordinator.
- **Setup chat is not the principal speaking.** Nothing said there is stored as the principal's
  preference, priority or fact: the setup agent has no write tools, and relationship extraction
  skips those turns.
- **The principal starts with a clean thread.** Start onboarding replaces the shared thread's
  conversation id, so the principal's first view of the console or phone app is their own. The
  setup conversation stays in working memory and the audit log.

After the hand-over, an operator who still uses the console is working in the principal's
thread. The Setup docs say so, and point operators at the settings pages instead of chat.

## Phase 2 — Onboarding (the principal)

### The onboarding plan

When the operator starts onboarding, Curia seeds one onboarding plan for the principal under
`/meetings/`, copied from a fixture in the repo. It keeps two things apart:

- **What to cover:** the sessions and the topics each should reach.
- **What's happened:** topics covered and left, the formats the principal chose, and what they've
  said about timing and interests.

The principal may edit the plan at any time. Curia records coverage in *what's happened* from
each session's minutes. It changes *what to cover* only with what the principal agreed in a
session (a directed change), never on its own judgment.

Onboarding never starts on its own: the operator starts it (2.1), or the principal asks for it.
So existing installs (prod included) are never pulled in, nobody gets an unexpected "Hi, I'm
Curia", and triage is not switched off under them. On an install that already has a working
principal, the console warns before starting it. The fixture is the onboarding playbook:
improving it improves onboarding for every principal who starts after.

**Sessions are booked one at a time.** At the end of each session the principal and Curia agree
the next one, and the post-session follow-up (the minutes guidance in the `meetings` bundle) books only
that one. Interests, timing and availability shift as onboarding goes on.

**Sessions live on the principal's calendar.** Once the principal's calendar is connected
(normally during the first conversation), every session (the review, check-ins, the weekly
session) is a real event on it, marked busy, with the principal as the only attendee. Booking it
is a directed change the principal agreed in a session; if the autonomy band still requires
approval for a calendar write, the principal gets one approval prompt, which they were told to
expect. The principal moves or cancels it like any other meeting.

**The agenda follows the event.** Each session's agenda, its nudge and any pre-session delivery
(the drafts email) are tied to the calendar event, not to a fixed time:
- **Moved:** the agenda, nudge and delivery move with it.
- **Cancelled:** Curia asks the principal when they'd like to do it instead, once, and books the
  answer.
- **Late or early:** the agenda stays loadable until the session happens or is replaced, so a
  principal who calls an hour late still gets it (today's ±12h `isDue` window would drop it).

How Curia notices a move (a calendar webhook, or re-reading the event before each step) is the
builder's call; the requirement is that a moved event never leaves a stale nudge or an orphaned
agenda. If the principal hasn't connected their calendar yet, the next session is a scheduler
job with a nudge, as in the earlier design, and becomes an event once the calendar is connected.

**Every session runs by voice or chat,** whichever the principal chose for it. Both run from the
same agenda:

- **Voice:** the agenda is parked; Curia nudges; the principal calls in from the PWA, console or
  Signal, and the agenda loads at session start (#2359).
- **Chat:** Curia opens the session in the principal's messaging channel and works through the
  agenda one topic at a time. Multiple-choice questions are numbered options (the PWA may render
  them as buttons; builder's call). A chat session ends when the agenda is complete, the
  principal says they're done, or it has been idle for a set time. Uncovered topics carry to the
  next session, and the minutes are produced from the transcript at that point.

### 2.1 The invitation (the operator says "go", Curia reaches out)

**The operator decides when.** Setup can finish days before the principal is ready, and the
operator knows the principal's week. So nothing goes to the principal when Setup completes.
Instead the console's **Start onboarding** step unlocks, and the operator presses it when the
time is right.

**Starting onboarding** seeds the onboarding plan, writes the triage switch off (see *Triage
switch*) and gives the operator what they need to bring the principal in:

- **Phone app route:** an **invitation link** to send the principal through whatever channel the
  operator knows works best (a text, a Slack message, a note in person), with suggested wording
  the operator can copy and adapt. The link installs and pairs the app on the phone it's opened
  on. It is valid for **48 hours**, and the console and suggested wording both say so, so the
  operator can tell the principal to do it soon.
- **Signal or SMS route:** no link is needed. Starting onboarding has Curia send the principal a
  short hello on that channel, and the console shows the operator what was sent.

Curia doesn't email the invitation. The operator's own channel carries more weight with the
principal than a message from an assistant they haven't met, and it keeps the link out of an
inbox.

**Then Curia reaches out first.** As soon as the app is paired, or with the Signal or SMS hello,
Curia greets the principal and invites them to the first conversation. The greeting:
- introduces Curia by name, in a sentence or two, and says who set it up;
- says what the first conversation is for and roughly how long it takes (about 20 minutes);
- offers voice or chat, and how to start each ("tap here to call me", or just reply);
- doesn't ask anything else.

If the principal doesn't reply, Curia follows up, politely and with a cap on frequency, then
stops and tells the operator through the console. It stays usable for ad-hoc chat throughout.

**The invitation link changes ADR-055.** Today's pairing code is minted for the person holding
the desktop console and expires after 10 minutes. The invitation link is minted by the operator
for someone else and has to survive being sent and waiting to be opened:
- single-use, bound to the principal, and expiring after **48 hours**;
- minted only from an authenticated console session;
- the token stays in the URL fragment, as now, so it never reaches proxy or server logs;
- generating a new link invalidates the previous one;
- the console shows the operator whether the link is waiting, redeemed or expired.

This needs an amendment to ADR-055.

### 2.2 The first conversation (voice or chat)

One session, agenda-driven, mostly multiple choice. Curia reads back what it heard after each
part, in plain words, and the principal confirms or adjusts.

1. **Hello.** Who Curia is, and what this conversation will cover.
2. **How Curia should work with you: style.** A few paired choices, for example:
   - "Should I be more chatty and thorough, or more brief and to the point?"
   - "More dry, or more humorous?"
   - "Warm and personable, or crisp and businesslike?"
   - "When I'm not sure, should I ask, or make a sensible call and tell you?"

   Each question offers two to four options plus "something else" as an escape. Curia turns the
   picks into its tone and style text and its detail setting (`tone.style`, `tone.verbosity`;
   spec 13), reads back a short sample of how it will sound, and offers one round of tweaks.
   This is Curia's own style when it talks to the principal. It is separate from the principal's
   writing voice, which the deep dive learns (2.3).
3. **How independent Curia should be: autonomy.** "Which of these sounds closest to how you'd
   like me to start?" Curia describes three bands in plain words, with an example of each:
   - **Draft only:** I prepare things and you send or book them.
   - **Ask first (recommended):** I handle routine things and check with you before sending on
     your behalf or booking meetings.
   - **Spot-check:** I act on most things and you review afterwards.

   The pick sets the starting score (65, 75 or 85). *Full* and *Restricted* aren't offered on day
   one; Curia hasn't done any work yet to justify the first, and the second leaves it unable to
   help. Curia adds the plain-words line: "As you approve things, I'll ask less."
4. **Standing preferences.** Multiple choice again: how to reach the principal for something
   urgent versus routine; quiet hours; whether they want a daily recap and roughly when; how they
   want to hear about unsent drafts ("Do you think you'll see those, or would you rather I send
   you an end-of-day reminder if there are drafts left unsent?").
5. **What to expect.** Built from Curia's current settings when the agenda is generated, so it
   never promises behaviour Curia won't show:
   - **Inbox:** Curia labels mail and archives some of it, so mail will leave the inbox on
     purpose. It says where that mail goes.
   - **Calendar:** Curia may place tentative holds to protect time, and will put the sessions
     agreed with the principal on their calendar. Whether booking or moving other meetings asks
     first follows the autonomy band just chosen; Curia says which.
   - **Drafts:** as agreed in step 4.

   Inbox triage switches on after this topic (see *Triage switch*).
6. **Connect your email and calendar.** Why Curia wants delegated access to the principal's own
   mailbox and calendar, separate from Curia's inbox, and what it will and won't do with it.
   Curia sends the sign-in link in the session's channel; the principal signs in there and then.
   Curia confirms when the connection arrives. If the principal would rather not yet, the topic
   stays open in the plan and the deep dive waits; Curia keeps working from its own inbox.
7. **How you'd like to review what I find.** Curia explains the deep dive: over the next day or
   two it will draft the principal's working rules, priorities and writing voice from their
   history, as Google Docs. Then it asks: "When I put review time in your calendar, would you
   like to go through it together on a call, or review on your own and then text with me?"
8. **Next step.** Curia will find a time on the principal's calendar for the review and send the
   drafts beforehand. The principal can also say how often they'd like to check in over the next
   couple of weeks; that goes in the plan as a preference, not a fixed series.

**After the conversation,** the structuring pass writes the style and autonomy choices to their
existing stores (office identity, autonomy config), creates any routines agreed in step 4 (daily
recap, drafts reminder), records the review-format choice in the plan, and switches triage on.
These are directed changes: the principal agreed them in the session.

### 2.3 The deep dive (offline)

1. **Trigger.** The one-time "connected" event from the sign-in callback starts a background job,
   once. A re-run takes an explicit operator or principal action.
2. **One read, three drafts.** It reads a window of calendar and mail history (about 90 days by
   default, configurable) once, and writes three drafts. Every item carries the evidence behind
   it, by reference to specific threads or events.
   - **Working rules:** how the principal handles mail (senders they always answer quickly, mail
     they never open, threads they hand off) and how they schedule (times they keep clear,
     meeting lengths, buffers, which meetings they decline or move).
   - **Priorities and goals:** recurring meetings, frequent correspondents, and threads with high
     effort or high stakes, framed as what the principal is focused on.
   - **Writing voice:** how the principal writes, drawn from their sent mail: greetings and
     sign-offs, length, formality by audience, phrases they use and avoid. It maps onto the
     existing writing-voice profile (`executive-profile`, provenance `seeded`), so the weekly
     `voice-learn` job keeps refining it from draft-versus-sent differences afterwards. The draft
     includes two or three sample replies written in that voice, so the principal can judge it
     by reading it.
   - **Model:** the strongest configured tier. This is a one-time, high-stakes read, and quality
     beats cost.
   - **Cost:** no cap. The job estimates its cost before starting, logs the actual spend, and the
     first real run's measured cost is recorded on the issue.
3. **Existing rules and voice settings are kept.** A draft item that conflicts with one is
   flagged in the draft, not silently replaced.

### 2.4 Delivery

- **Google Docs.** Curia writes the three drafts as Google Docs from its own Google account and
  shares each with the principal as `writer`, following the existing Drive convention. Each doc
  opens with a short note: what it is, that nothing in it is in effect yet, and how to respond
  (edit, comment, or tell Curia).
- **One email** from Curia to the principal linking all three docs, saying what to look at first,
  and when the review is.
- **A review session on the principal's calendar.** Curia finds a clear time in the next few
  working days and books it as a real event (see *Sessions live on the principal's calendar*),
  titled for the format the principal chose ("Review Curia's drafts — call Curia" or "Review
  Curia's drafts"), with the three doc links in the description. The email goes out a day or so
  before the event, and moves with it.

### 2.5 The review (adapts to the principal's choice)

- **Together on a call:** at the event, Curia parks a review agenda and nudges. The agenda walks
  the drafts, strongest and most surprising items first, and reads the writing-voice samples
  aloud for a reaction. Edits agreed on the call are applied to the docs afterwards by the
  structuring pass.
- **On their own, then text:** at the event, Curia messages the principal that the drafts are
  ready and it's available. The principal edits or comments in the docs and texts Curia with
  questions or changes; Curia answers and applies them.

Either way:
- Curia reads the docs back, including the principal's edits and comments, and replies to each
  comment.
- When the principal says a draft is right, Curia writes the confirmed version into the Curia
  app: `/shared/inbox/rules.md` and `/shared/calendar/rules.md` (one `##` section per rule),
  `/shared/principal/priorities.md`, and the writing-voice profile.
- Curia sends a **receipt** with what it set and a console link to each ("Here's what I've set.
  You can change these anytime here."). The receipt doesn't wait for a reply.
- Each Google Doc gets a line at the top saying it has moved to Curia and that edits there are
  no longer read, with a link to the console page where the principal can see and change it:
  the documents page for the rules and priorities, and the ghostwriting settings for the writing
  voice. The doc itself is left in place for the principal.
- Nothing acts on a draft until it is confirmed. Confirmation is per document: the principal can
  confirm rules today and voice next week.
- At the end of the review, the principal and Curia agree the next session.

### 2.6 Check-ins

Short sessions, booked one at a time, while the newly-switched-on work beds in. Each is built
from what has happened since the last: how triage is going, any drafts left unsent, approvals
Curia asked for, anything the principal corrected. The plan suggests about two over the first
couple of weeks; the principal sets the cadence. When the principal's corrections have settled,
Curia proposes moving to a weekly session.

### 2.7 The weekly session

The end state of onboarding, and a routine that continues after it: a recurring conversation
about getting more value from Curia. It isn't a status meeting. It runs from an agenda Curia
generates each week from what actually happened, by voice or chat as the principal prefers:

- **Independence.** Recent decisions and approvals, and a proposal to adjust autonomy up or down,
  with the evidence. The principal decides.
- **Feature upkeep.** Whether features earn their place, for example whether decision tagging
  should stay on or be cleaned up. Curia proposes; the principal decides.
- **New plays.** Routines the principal doesn't use yet (daily debriefs, a weekly calendar scan,
  meeting debriefs, the drafts reminder), suggested from a catalog of known plays and from what
  Curia noticed in the principal's week. Changes the principal agrees are directed changes.
- **Priorities.** Whether any have gone stale or new ones are showing up; agreed changes are
  written to `/shared/principal/priorities.md`.

It is booked as a recurring event on the principal's calendar. Each week's agenda is generated
and parked shortly before that week's occurrence, and follows it if the principal moves or skips
it.

**Onboarding is "done" when** the principal has confirmed the deep-dive drafts and agreed a
weekly session. "Done" marks the end of capture, not reliance: the principal approves or corrects
what Curia does, the autonomy score rises, and check-ins fade. The HAWD model's A5 describes this
loop.

### Triage switch

Scheduled inbox triage labels and archives mail, which is the most surprising thing Curia does to
a new principal. ceo-inbox gets a `ceo_inbox/triage` config (`{"enabled": …}`), beside
`ceo_inbox/decision_tagging`.

- Seeding the onboarding plan writes it **off** on a fresh install. A missing value means on, so
  existing installs (prod included) keep triaging when this ships.
- It switches on after the first conversation's "what to expect" topic, as a directed change,
  whether the conversation ran by voice or chat.
- The principal can switch it off or on again at any time.
- It is not held back until rules are confirmed. Once on, it runs as it does today with whatever
  rules exist, and the review tunes it.

Calendar needs no switch: whether real meetings need approval follows the autonomy band, and
holds are named in "what to expect".

### Priorities: scope

- **Where they live:** `/shared/principal/priorities.md`, no hard size limit (#2338's size
  warning is the safeguard). The principal can edit it in the console.
- **Who uses it:** the coordinator (`pinned_context`, #2338); voice, read once at session start
  (#2363); the daily recap; the weekly session.
- **Not in this milestone:** ceo-inbox and calendar don't pin it. If we want it, it's a later
  experiment with a before-and-after comparison.

## How the docs tell it

Operators told us they didn't know what to expect or how to get set up. An audit of curia-docs
(2026-11-01) shows why:

- **No starting point.** The first tab is Core Concepts; `index.mdx` is in no nav group. Nothing
  says who does what, how long it takes, or what you'll need.
- **No finish line.** The only checkpoint is the `/setup` form (`installation.mdx:95`). Channel
  pages have no shared "verify" step, and nothing points at `setup-status` or `/api/health`.
- **Requirements surface late.** Prerequisites list Docker and curl (`installation.mdx:12-17`);
  the API key, HTTPS, a dedicated mailbox, Nylas, a phone number and the voice vendors appear
  only as you hit them.
- **Operator and principal are treated as one person.** The `/setup` form asks "your name (the
  CEO Curia works for)"; `signal-setup.mdx:16` conflates the principal's number with Curia's;
  `voice-setup.mdx:14` says "the person on the call is you, the principal".
- **Gaps.** No public page for the principal's mailbox (calendar is disabled without it,
  `curia/src/index.ts:1166`), Google Workspace (the guide exists only in
  `curia/docs/dev/google-drive.md`), or the phone app.
- **Duplication and drift.** Nylas and Signal steps appear both in `installation.mdx` and on
  their channel pages, and have drifted apart (Appendix A).

### Principles

1. **Lead with "what to expect".** The first page anyone lands on says: there are two phases;
   who does each; how long each takes; what it costs; what you'll need; what the principal will
   experience; and how you'll know you're done.
2. **Every page has one reader.** Setup pages are written to the operator. Onboarding pages are
   written to the principal, short enough that an operator can forward one.
3. **Every Setup page has the same shape:** what it's for; what you'll need (accounts, time,
   cost, dated); steps; **check it works**; what the principal will notice.
4. **One finish line.** A "Check your setup" page is the definition of done. It matches
   `setup_complete` item for item and ends with **Start onboarding**: when to press it, and
   sending the principal the 48-hour link.
5. **Each fact lives in one place.** The install page links to channel pages instead of
   repeating their steps.
6. **Ship the Setup half now.** It describes today's behaviour and fixes the operator pain
   immediately. Onboarding pages, the phone app page and the sign-in version of the mailbox page
   land with the features they describe; until then, *What to expect* says plainly what the
   principal's first run looks like today.

### Target nav: the Get Started tab, moved first

| Group | Page | Reader | Purpose | Built from |
|---|---|---|---|---|
| Overview | **What to expect** | Both | The two phases, who does what, time and cost, the "you'll need" checklist, what the principal experiences | `index.mdx`, `introduction.mdx` (trimmed), this design |
| Setup | **1. Install Curia** | Operator | Image install, HTTPS by default, local labelled try-out | `installation.mdx:1-110`, `deployment.mdx:9-20` |
| | **2. Curia's own email** | Operator | Nylas account and a dedicated mailbox | `email-setup.mdx`, `installation.mdx:121-149` |
| | **3. Reach your principal** | Operator | Choosing the route: phone app by default (the principal installs it from the invitation link), Signal or SMS; linking the principal's identity | New; links to `signal-setup`, `sms-setup` |
| | **4. Voice** | Operator | LiveKit, Deepgram, Cartesia; choosing Curia's voice; calling from the phone app | `voice-setup.mdx` |
| | **5. Your principal's email and calendar** | Operator | Preparing the sign-in the principal will use (Google accounts; today: the hand-made grant) | New |
| | **6. Google Docs** | Operator | Curia's Google account and Drive access | Port of `curia/docs/dev/google-drive.md` |
| | **7. Optional: search and memory** | Operator | Embeddings, Tavily | `installation.mdx:151-188`, `integrations/*` |
| | **8. Check your setup** | Operator | The finish line: every item verified, then Start onboarding and the invitation link, and what the operator does (and doesn't do) in the console afterwards | New; parts of `health-monitoring.mdx` |
| Onboarding | **Your first conversation with Curia** | Principal | Putting Curia on your phone from the link, Curia's greeting, voice or chat, what Curia will ask and why | Rewrite of `playbooks.mdx:8-50` |
| | **Connecting your email and calendar** | Principal | What delegated access means, what Curia will and won't do, what to expect | New |
| | **Reviewing what Curia learned** | Principal | The three drafts, how to edit or comment, what happens on confirm | New |
| | **Check-ins and your weekly session** | Principal | What they cover; changing autonomy and routines; new plays | New; `examples/*` |
| Running Curia | Secrets vault, Deployment and self-hosting, Health monitoring | Operator | Kept as they are | — |

Also:
- `development.mdx` moves to a Contributing group; `configuration.mdx` merges into
  `references/configuration`; playbooks' autonomy and second-account sections move to Running
  Curia.
- Channel pages keep their reference role under Channels, with audience fixes: they address the
  operator and say whose number or mailbox each value is.
- `index.mdx` either joins the nav as the landing page or redirects to *What to expect*.
- The README and website hero use the same two-phase summary:

> **Getting started has two phases.**
> **Setup** (whoever runs Curia; about 5 minutes to install, then an hour or two to connect):
> Docker, an LLM key and a domain, then Curia's own email, a way to message you, a voice, and
> access to Google Docs.
> **Onboarding** (you, the executive): Curia invites you to a first conversation, by voice or
> chat, and takes it from there.

The time estimates above are placeholders to be checked against a timed run-through when the
pages are written.

## Decisions

| Topic | Decision | Whose call |
|---|---|---|
| Phases and names | Getting started = Setup (operator) + Onboarding (principal); "desk" retired; "deployment" keeps its hosting meaning | Joseph |
| Setup before Onboarding | The operator decides and connects every channel first; the principal is never asked to set one up | Joseph |
| Default messaging route | PWA (#2341); Signal and SMS are alternatives the operator chooses | Joseph |
| Curia's name and spoken voice | Chosen by the operator in Setup | Joseph |
| Setup agent scope | Setup only; no persona, tone, autonomy or priorities content | Joseph |
| Voice in Setup | Required, so the principal's voice-or-chat choice is real | builder's call |
| Readiness | One `setup_complete` flag, all required items verified; replaces `kickoff_ready` / `sessions_ready`; unlocks **Start onboarding** rather than starting it | builder's call (flag); Joseph (operator starts) |
| First contact | The operator starts onboarding when ready and sends the invitation link through their own channel; Curia then greets the principal first | Joseph |
| First conversation | One session, voice or chat: style, autonomy, preferences, what to expect, mailbox sign-in, review format | Joseph |
| Question style | Mostly multiple choice with described options; Curia infers settings and reads them back | Joseph |
| Autonomy options on day one | Three bands (Draft only, Ask first, Spot-check), "Ask first" recommended | builder's call |
| Chat sessions | First-class, same agenda as voice; ends on completion, principal's word, or idle timeout | Joseph (chat in scope); builder's call (mechanics) |
| Principal mailbox | Nylas hosted authentication; operator configures the provider in Setup; principal signs in during the first conversation | Joseph |
| Principal accounts | Google only in this milestone; Microsoft 365 is a follow-up | Joseph |
| Console identity | The operator's during Setup, the principal's after; setup agent asks "for yourself or for someone else?"; setup chat never stored as the principal's | Joseph (rule); builder's call (clean thread) |
| Invitation channel | Phone app: an operator-generated link sent by the operator; Signal or SMS: a hello from Curia on that channel. Curia doesn't email the invitation | Joseph |
| Invitation link | Single-use, principal-bound, 48 hours, minted from the console; ADR-055 amendment | Joseph (48 hours, operator-sent); builder's call (rest) |
| Sessions on the calendar | Real busy events once the calendar is connected; the agenda, nudge and delivery follow the event when it moves | Joseph |
| Deep dive | One read, three drafts: working rules, priorities, writing voice; strongest tier; no cost cap | Joseph |
| Writing voice | Seeds the existing writing-voice profile; `voice-learn` refines it afterwards | builder's call |
| Draft delivery | Google Docs shared with the principal, one email, a review session booked on their calendar | Joseph |
| Review format | Asked in the first conversation: call together, or review alone and text | Joseph |
| Final home | Confirmed versions live in the Curia app; each Google Doc is marked as moved, with a link to its console page | Joseph |
| Sessions | Booked one at a time; check-ins taper into a weekly session | Joseph |
| Weekly session | Independence, feature upkeep, new plays, priorities | Joseph |
| Done | Drafts confirmed and a weekly session agreed | builder's call |
| Triage switch | Off on a fresh install; on after "what to expect", by voice or chat | Joseph (switch); builder's call (chat too) |
| Priorities scope | Coordinator, voice, recap, weekly session; no specialist pinning | Joseph |
| Operator role | Design issue only (#2365) | Joseph |
| Setup surface | One Setup page in the console: every field on its step, one Save and continue per step, fields save on leaving them; the setup agent is a help panel beside it (#2358) | Joseph |
| Google Docs in Setup | An optional extra, not required: its sign-in isn't in the console yet (#2683) | builder's call |
| Working style in Setup | Optional extra; a starting point the principal is offered, never a decision for them | Joseph |
| Capabilities | Switches in Setup and Settings; Meetings always on; Email triage locked in Setup; Diagnostics off by default | Joseph |

## Work breakdown

Tracked in milestone **v0.48 - Onboarding Journey** (#29).

| Issue | Change from the 2026-10-29 breakdown | Depends on | Size |
|---|---|---|---|
| #2356 **Getting-started docs: Setup, then Onboarding** | Retitled. Two-phase framing replaces "install, then desk"; the curia-docs restructure in *How the docs tell it*; Appendix A fixes. The Setup half can ship before the features, describing today's behaviour; Onboarding pages land with the features. | — | L → XL |
| #2357 Installer: HTTPS-first, voice on by default | Closing message points at the Setup checklist; wording only. | — | L |
| #2341 PWA | Adds the operator-generated invitation link and the ADR-055 amendment (or a small follow-up issue if #2341 is already in flight). | — | XXL |
| #2358 **The Setup page** (was "Setup status, Setup-only setup agent and `/setup` form") | Grew into the console's Setup page: one readiness flag over the required steps (`setup_state`, the shared checklist); every step's fields inline; optional extras (Working style, Google Workspace, Tavily key, Capabilities); the setup agent reworked as a help panel docked beside the page, with setup chat kept out of the principal's memory and a clean thread at hand-over. Shipped as PRs #2686, #2687, #2688, #2690, #2691, #2693 and Capabilities. | — | M → XXL |
| #2359 Console and PWA calls load the parked agenda | Unchanged. | — | S |
| #2360 **Onboarding program** | Rewritten: the console's Start onboarding step and Curia's greeting; one first conversation by voice or chat with multiple-choice style, autonomy and preferences; review-format choice; review session that adapts; check-ins; weekly session. Absorbs chat sessions (#2364) and the setup agent's onboarding content. | #2358, #2359, #2361, and #2341 for the default route (Signal or SMS work without it) | XL → XXL; consider splitting the weekly session out |
| #2361 **Principal mailbox sign-in** | Rewritten: Nylas hosted authentication (Google connector) with a callback on the Curia server, picking up the grant without a restart, an operator Setup guide, the in-conversation link, and the "connected" event. Replaces the hand-made grant guide. | #2358 | M → L |
| #2362 **Deep dive** | Adds writing voice as the third draft; delivery as Google Docs, one email and a review session on the calendar; confirmation from the docs and the review session instead of the numbered-list email. The ADR also covers writing voice and drafts held in Google Drive. | #2360, #2361, #2338 | XL → XXL |
| #2363 Voice loads priorities | Unchanged. | #2362 | S |
| #2364 Spike: text-chat sessions | Folded into #2360; closed. | — | — |
| #2365 Design: operator role | Unchanged, still off the critical path. | — | S |

**Critical path:** #2358 and #2361 → #2360 → #2362. #2356 (Setup half), #2357, #2359 and #2365
can run in parallel.

## Left to the builder

- **Agenda wording** for each session type, the topics in the plan fixture, and the exact
  multiple-choice questions and options, within *2.2*.
- **The mapping from style picks to `tone.style` and verbosity.** Start from the console's four
  starter styles.
- **Evidence heuristics are not left to the builder.** Which signals count for rules, priorities
  and writing voice, and how they're weighted, is a written deliverable of #2362, reviewed with
  the rest of it.
- **Invitation and nudge copy,** and their frequency caps, within the "no session spam"
  anti-goal.
- **Chat session idle timeout.**
- **Format of the priorities document:** described in its own frontmatter, per #2338.

## Appendix A — setup-doc inconsistencies to fix in #2356

1. **LLM providers.**
   - `curia-docs/core-concepts/introduction.mdx:108` lists Ollama, which has no provider in the
     code.
   - Bedrock appears only in the dev docs.
   - The installers hard-require an `sk-ant-` key, while `seed-vault.ts:58` says no provider is
     mandatory.
2. **Website prerequisites.** The hero (`curia-website/src/pages/HomePage.jsx:239-254`) lists the
   source-install prerequisites (node, pnpm), which the image install doesn't need.
3. **API key missing.** The installation page's Prerequisites list (`installation.mdx:12-17`)
   omits the API key that a later step asks for.
4. **Embeddings described as optional.** `docs/dev/setup.md:255` says the setup wizard is off
   without embeddings. Verify this and state it.
5. **Email vault key names** differ across `how-channels-work.mdx`, `installation.mdx`,
   `email-setup.mdx`, `.env.example` and `docs/dev/setup.md`.
6. **Email activation.** `installation.mdx:147` says email "activates automatically", but
   `docs/dev/setup.md:249` says it must be enabled in the console's channel registry.
7. **Signal socket path.** The catalog asks for `channel.signal.socket_path`; the docs say not to
   set it. `signal-setup.mdx:122` also links to the wrong step.
8. **Stale specs.** Spec 18 (`:44-45`) and `docs/dev/setup.md:104` describe channel variables in
   `.env`. Spec 08 (`:53-91`) describes a `curia setup` CLI that doesn't exist.
9. **Channel lists.** The README (`:43`), `introduction.mdx` and `index.mdx` name only email and
   Signal.
10. **Email transport.** `introduction.mdx:95` says "IMAP polling + SMTP via Nylas"; it is the
    Nylas API.
11. **Time claims.** `index.mdx:10` says "under 15 minutes" and `installation.mdx:6` says "about
    five minutes". Neither survives the new framing; use the two-phase estimates.
