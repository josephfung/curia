# Design: Specialist Collaboration + Calendar Holds for Scheduling Replies

- **Date:** 2026-06-23
- **Status:** Draft (approved architecture, pending spec review)
- **Branch:** `feat/calendar-holds-collaboration`

## Problem

When someone emails the CEO asking for availability (a coffee, a call, a
meeting), the `ceo-inbox` agent drafts a reply that proposes times. It does this
**completely blind to the calendar**, which causes three real problems observed
in production:

1. **Proposed times collide with busy events.** ceo-inbox never checks the
   CEO's calendar for conflicts. Overlap with *free*-status events is fine;
   overlap with *busy* events is not.
2. **The same times get re-offered across different threads.** Nothing tracks
   what has already been offered, so if two recipients accept, the CEO is
   double-booked.
3. **Times are never timezone-qualified.** Drafts say "10:30 AM", never
   "10:30 AM ET", even for virtual meetings with non-local or unknown-location
   contacts.

### Evidence (production, last 7-10 days)

A read-only audit of the prod `audit_log` confirmed all three:

- Over 7 days, `ceo-inbox` invoked **only** `date-resolve`. It called
  `calendar-find-free-time` **zero** times, `calendar-check-conflicts` **zero**
  times, and `delegate` **zero** times. The calendar specialist *was* used last
  week — but only by the coordinator, contacts, and meeting-debrief, never on
  behalf of inbox drafting.
- This is by design: [`agents/ceo-inbox.yaml`](../../agents/ceo-inbox.yaml)
  (current lines ~460-488) explicitly tells the agent *"No calendar access. You
  cannot check the CEO's calendar for conflicts"* and to append "pending your
  calendar".
- The same prompt says *"Prefer mid-morning slots (9:30-11:30 AM)"*, so the
  model gravitated to the same two defaults — **10:30 AM primary, 11:00 AM
  backup** — almost every time. In the sample, `Thu June 25 @ 10:30 AM` was
  offered to two different people in the same week, and `10:30/11:00` pairs went
  to at least four contacts.
- Every scheduling draft was unqualified ("10:30 AM"), including one explicitly
  labelled "a virtual sync".

**Root cause:** ceo-inbox drafts scheduling replies blind. The calendar tooling
to fix this already exists; it is simply never wired into the inbox path. A
secondary gap: the existing conflict/free-time skills treat *all* events as
blocking and do not distinguish busy from free.

## Goals

- ceo-inbox proposes **conflict-free** times (avoiding *busy* events; *free*
  events do not block).
- The same slot is **never re-offered** across concurrent threads, because
  proposed slots are tentatively held the moment they are offered.
- Proposed times are **always timezone-labelled** in the CEO's timezone (with
  the contact's local time in parentheses when known).
- The fix is built as a **general specialist-collaboration capability**, not a
  ceo-inbox point patch. The calendar specialist owns *all* calendar logic;
  ceo-inbox collaborates with it.
- **No new database tables.** State lives where it naturally belongs.

## Non-goals

- No synchronous cross-agent RPC primitive. We deliberately keep the existing
  async bullpen model.
- No change to how the coordinator routes top-level requests.
- No multi-party scheduling negotiation engine. We propose times and hold them;
  we do not run a back-and-forth availability solver across attendees.
- No new calendar backend. Nylas remains the integration.

## Architecture overview

Three layers, each building on the last. One spec, sequenced 1 -> 2 -> 3.

1. **General pattern — "bullpen consult-and-resume".** A reusable convention
   over the *existing* async bullpen: an agent taps a specialist, parks its
   current work, and resumes when the reply arrives. No new primitive, no new
   event types.
2. **Calendar holds, owned by the calendar specialist.** Tentative `HOLD (TBC)`
   events that the calendar specialist creates, tracks, self-releases on real
   booking, and expires — behind a principal-tunable toggle. **The hold *is* the
   calendar event; its metadata is the ledger.**
3. **Rewire ceo-inbox scheduling.** Replace "draft blind + disclaimer" with
   "consult calendar, then draft with held, timezone-labelled slots."

---

## Layer 1 — General pattern: bullpen consult-and-resume

### Why a convention, not a new primitive

The bullpen is **asynchronous by design**: `bullpen.post` persists the thread
and fires the `agent.discuss` event fire-and-forget (deliberately not awaited,
to avoid the skill-timeout/duplicate-thread hazard of issue #721). A tapped
agent is woken as a *separate* task and replies to the thread; the originator
reads that reply on a *later* turn. The only synchronous cross-agent primitive,
`delegate`, is locked to `allowed_callers: ["coordinator"]` — the top-down
routing we are intentionally not using here.

We chose (with the CEO) to stay async. Email triage is not latency-critical and
drafts sit for human review regardless, so a draft landing seconds-to-minutes
later is acceptable. Async also never holds an execution turn open and
generalizes to tapping multiple specialists at once.

### The pattern

Any agent that needs another specialist's expertise mid-task:

1. **Tap.** Call `bullpen.post` mentioning the specialist, with a *structured
   consult request* in the content (shape below) that carries the originating
   context (`source_message_id` / a task ref) and a clear "what I need back".
   Pass `source_message_id` as the dedup key (already supported) so retries and
   re-polls never spawn duplicate threads.
2. **Park.** Mark the originating work as in-flight so it is not re-processed
   while waiting. The generic marker is the `⏳ In Progress` label (see below).
   The originating item is **not** completed/archived yet.
3. **Resume.** When the specialist's `bullpen.reply` wakes the originator (the
   `BullpenDispatcher` already creates a task for thread participants), the
   originator reads the reply, re-opens the original work via the carried
   context, completes it, and clears the park marker.

### Structured consult request/reply shape

The only new shared artifact. A few labelled lines so both sides agree on
format and the exchange is auditable. Example (scheduling):

```
CONSULT REQUEST
Need: 2 conflict-free 30-min slots, with holds placed, returned timezone-labelled
For:  reply to <contact display name> re "<subject>"
By:   slots within <date window / stated constraints>
Context: source_message_id=<id>; contact_timezone=<known|unknown>
```

```
CONSULT REPLY
Result: ok
Slots:
  1. Thursday June 25 at 10:30 AM ET (7:30 AM PT their time) — hold placed
  2. Tuesday June 30 at 11:00 AM ET (8:00 AM PT their time) — hold placed
Notes: <optional>
```

Fallback reply variants the requester must handle:

```
Result: no_slots
Nearest: <alternative slots outside the requested window, if any>
```
```
Result: escalate
Reason: <why the request could not be satisfied; requester routes a note to the CEO instead of drafting>
```

### The `⏳ In Progress` park marker

A **generic** "I am waiting on a collaborator" marker — intentionally not
scheduling-specific, so it works for any future consulted task.

- For ceo-inbox, it is a Gmail label `⏳ In Progress` applied to the source
  message via `ceo-inbox-label`.
- The triage loop **skips messages carrying `⏳ In Progress`** (treats them as
  in-flight, no re-classification).
- The bullpen `source_message_id` dedup is the **backstop**: even if the label
  is ever missed, a duplicate `bullpen.post` returns `deduplicated: true` rather
  than opening a second thread.
- The marker is cleared when the work completes (for ceo-inbox, the message is
  archived after the draft is written; the label removal/archival ends the park
  state).

### Scope of Layer 1 work

- Documented consult request/reply shape (lives in agent prompts, reused by both
  sides).
- ceo-inbox + calendar prompt wiring (covered in Layers 2 and 3).
- Triage skip rule for `⏳ In Progress`.
- No code changes to the bullpen service or dispatcher.

---

## Layer 2 — Calendar holds (owned by the calendar specialist)

### Storage decision: the calendar is the ledger (no new table, no memory ledger)

A hold is just a Nylas calendar event tagged with metadata:

```
title:    "HOLD (TBC): <subject>"
busy:     true
status:   tentative
attendees: none      # no invites, no notifications
metadata: { "curia-hold": "true", "source-ref": "<msg-id>", "created-at": "<iso8601>" }
```

The calendar becomes the single source of truth. This was an explicit design
choice to avoid yet another transient-state table:

- **Avoid re-offering** — holds are `busy=true`, so the busy-only free-time
  filter (below) skips them automatically. A held slot is never suggested to a
  second contact.
- **Self-release on booking** — when `calendar-create-event` books a real
  meeting, list events overlapping the new slot, keep those tagged
  `curia-hold`, and delete them. No local lookup.
- **Expiry sweep** — a scheduled job lists tagged events over a bounded forward
  window and deletes any whose slot is already past or whose `created-at` is
  older than the max hold age (default 7 days).
- **State machine collapses** — "active" = the event exists; "released/expired"
  = it is deleted. There is no separate record to reconcile, so it cannot drift
  from calendar reality.

Why not a markdown ledger in memory/config: holds must stay *exactly*
consistent with the calendar (we delete specific events). Memory/config is the
right tool for soft recall and operator settings — and we *do* use `config-store`
for the toggle — but a ledger the cleanup job reconciles against live calendar
state must not live somewhere that can silently drift from it. Putting the
ledger *on* the calendar means it cannot drift, because it is the same object.

**Net new tables: zero.** Three pieces of state, all in their natural home:
hold ledger = event metadata; toggle = `config-store`; park marker = Gmail label.

### New skill: `calendar-create-hold`

- **Inputs:** `calendarId`, `start`, `end`, `title?` (default `HOLD (TBC)`),
  `subject?`, `sourceRef?`.
- **Behaviour:** check the toggle (below); if enabled, create the tagged Nylas
  event (busy/tentative, no attendees, metadata as above) and return the event
  id + the timezone-labelled display string. If disabled, return a "holds
  disabled" result so the caller proposes without holding.
- **Outputs:** `holdEventId`, `display` (timezone-labelled), `held: boolean`.
- **`action_risk: "medium"`** (min autonomy score 70). Lower than
  `calendar-create-event` (high/80) because a hold has no invitees, sends no
  notifications, is reversible, and auto-expires. *(Decision: confirmed.)*

### Nylas client plumbing

`metadata` exists in the raw Nylas API but is not exposed in the normalized
types today. Plumb it through:

- **Write:** `calendar-create-hold` -> Nylas `createEvent` must pass `metadata`.
- **Read:** `calendar-list-events` must surface `metadata` (and `status`) on the
  normalized `NylasCalendarEvent` so the release/expiry sweeps can filter on
  `curia-hold`.

Client-side filtering on the `curia-hold` key over a bounded time window is
sufficient; server-side `metadata_pair` filtering is a nice-to-have, not
required.

### Self-release on real booking

In the `calendar-create-event` path (real bookings only — `calendar-create-hold`
is a separate skill and never triggers this): after a successful booking, list
events overlapping the new slot on that calendar, keep those tagged
`curia-hold`, delete them. Keep this logic in the calendar domain (inline in the
create-event handler or a small helper it calls), so calendar ownership stays
intact.

### Expiry cleanup job

A recurring scheduled job (the scheduler already supports cron jobs) runs the
sweep: list `curia-hold`-tagged events over the next ~2 weeks, delete any whose
slot is past or whose `created-at` exceeds the max hold age (default 7 days),
log a one-line summary. `expires` is *derived* (slot-in-past OR age cap), so no
explicit expiry timestamp needs storing beyond `created-at`.

### Principal-tunable toggle

- `config-store` namespace `calendar_holds`, key `enabled`.
- **Default ON** (the CEO wants the behaviour). *(Decision: confirmed.)*
- "Stop holding times for me" -> coordinator delegates to the calendar
  specialist -> it stores `enabled=false`. The calendar specialist checks this
  before placing any hold and proposes without holding when off.
- `config-store` has no delete; re-storing `enabled=true` re-enables. Acceptable.

### Busy-vs-free filter fix

Add `onlyBusy` (default `true`) to `calendar-find-free-time` and
`calendar-check-conflicts`, so only `status: busy` slots block. This is what
makes "overlap with *free* events is fine, *busy* isn't" real. Our holds are
`busy=true`, so they are respected by the filter.

### Timezone

The calendar specialist resolves timezones and returns **display strings**, so
the LLM never does timezone math (per the repo rule: skills convert via
`toLocalIso()` and return a `displayTimezone` label):

- CEO timezone via `${principal_contact_id}` -> `entity-context` ->
  `contact.timezone` (canonical column).
- Contact timezone via the contact's `entity-context.contact.timezone` when
  known.
- Always label the CEO's timezone (e.g. `10:30 AM ET`); append the contact's
  local equivalent in parentheses when their timezone is known
  (e.g. `(7:30 AM PT their time)`).

### Scope of Layer 2 work

- New skill `calendar-create-hold` (manifest + handler + tests).
- Nylas client: expose/pass `metadata` and `status` on create and list.
- Self-release helper in the create-event path.
- Recurring expiry sweep (scheduled job + sweep logic).
- `onlyBusy` param on `calendar-find-free-time` and `calendar-check-conflicts`.
- Calendar specialist prompt: how to answer a scheduling consult (busy-filtered
  free-time, place holds if enabled, return timezone-labelled slots, fallbacks),
  and how to toggle holds on request.

---

## Layer 3 — Rewire ceo-inbox scheduling

Replace the current "Scheduling-specific drafting rules" in
[`agents/ceo-inbox.yaml`](../../agents/ceo-inbox.yaml):

- **Delete the "No calendar access" rule and the "pending your calendar"
  disclaimer** entirely.
- On a `✍️ Drafted` scheduling email, **do not draft blind.** Run consult-and-
  resume: tap the calendar specialist with the contact, duration, and any stated
  constraints; request *2 conflict-free slots, holds placed, returned timezone-
  labelled*. Apply `⏳ In Progress`; **do not archive yet.**
- **On resume** (calendar's reply): write the draft using calendar's returned
  display strings **verbatim** (e.g. `Thursday June 25 at 10:30 AM ET`, plus
  `(7:30 AM PT their time)` when known). Then archive and clear the marker.
- **Fallbacks:**
  - `no_slots` -> draft using the nearest alternatives the calendar returned.
  - `escalate` -> route a note to the CEO instead of drafting.
- Keep the existing date-verification discipline (`date-resolve` for every
  date + day-of-week pair) — now applied to calendar-supplied slots.

### Scope of Layer 3 work

- ceo-inbox prompt: replace scheduling rules with the consult-and-resume flow,
  the `⏳ In Progress` park + triage-skip, the resume/draft step, and fallbacks.
- Ensure ceo-inbox can act on a bullpen reply task (read original via
  `source_message_id`, draft, archive).

---

## Cross-cutting concerns

### Autonomy

- `calendar-create-hold` is `action_risk: medium` (70). If the CEO's autonomy
  score sits below 70, hold creation is gated/approval-requested by the existing
  execution-layer enforcement — acceptable and consistent with platform policy.
- Reads (`calendar-find-free-time`, `calendar-check-conflicts`) remain
  `action_risk: none`.

### Failure handling

- If the calendar consult never returns (specialist down, timeout), the source
  email stays labelled `⏳ In Progress` and unarchived — visible to the CEO,
  never silently dropped. *(Open consideration: a stale-`⏳ In Progress` sweep so
  a stuck consult eventually surfaces as `⚠️ Stuck`. See open questions.)*
- All skill failures log and continue per existing ceo-inbox conventions; a hold
  failure must not block the draft (the specialist can fall back to proposing
  without a hold).

### Versioning

- `ceo-inbox.yaml`, `calendar.yaml`: minor bumps (new collaboration capability).
- New skill `calendar-create-hold`: `0.1.0`.
- Modified skills (`calendar-find-free-time`, `calendar-check-conflicts`,
  `calendar-list-events`): minor bump (new input/output field).
- CHANGELOG `Added`/`Changed` entries per PR.

### Testing strategy (TDD)

- **Unit:** `calendar-create-hold` (tagging, toggle-off path, timezone label);
  `onlyBusy` filter (free events do not block, busy/holds do); self-release
  overlap selection; expiry sweep selection (past slot, age cap).
- **Integration (real Postgres + Nylas client seams):** consult-and-resume
  round trip (ceo-inbox taps -> calendar replies -> ceo-inbox drafts); hold
  placed on offer, released on real booking; `⏳ In Progress` triage-skip and
  dedup backstop.
- **No-table assertion:** confirm no migration is added for holds; metadata
  round-trips through create -> list.

## Sequencing

1. **Layer 2 first** for the read-side primitives the others depend on: the
   `onlyBusy` filter and Nylas `metadata`/`status` plumbing, then
   `calendar-create-hold`, self-release, expiry job, toggle.
2. **Layer 1** convention (the consult request/reply shape + `⏳ In Progress`
   triage-skip) and **Layer 3** ceo-inbox rewire land together, since the
   rewire is the first consumer of the convention.
3. Calendar specialist prompt updates alongside Layer 2/3.

## Open questions

1. **Stale park-marker recovery.** Should a periodic sweep promote a long-stuck
   `⏳ In Progress` message to `⚠️ Stuck` (e.g. consult unanswered for N hours)?
   Leaning yes, small follow-up; not blocking the core.
2. **Hold visibility to external free/busy.** `busy=true` holds make the CEO
   appear busy to anyone running free/busy against them. For tentative offers
   this is arguably honest, but worth confirming it is desired.
3. **Max active holds.** Should there be a cap (e.g. refuse to hold if N active
   holds already exist for the CEO) to bound calendar clutter, beyond the
   toggle + expiry? Probably YAGNI for v1.
