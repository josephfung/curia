# Debrief records, the coordinator acts

Date: 2026-11-02 · Status: implemented (#2431)

## Problem

The principal answers a debrief prompt with follow-ups ("draft an email to them suggesting
two dates"). The coordinator delegates the whole reply to meeting-debrief, which executes
the follow-ups itself with its own small toolset. Two failures follow from that.

1. **Drafts land where the principal never sees them.** meeting-debrief pins
   `email-draft-save`, which writes to Curia's own mailbox (the primary `email_accounts`
   row). The principal's mailbox is reachable only through ceo-inbox's tools, which
   meeting-debrief cannot reach (`allow_discovery: false`, no `delegate`). Every one of
   meeting-debrief's prod drafts went to Curia's mailbox, and its prompt
   (`Step D4` sample: "check your drafts") told the principal otherwise.
2. **Anything beyond a draft, a calendar event or a KG fact can't be done.** "Book dinner
   Wednesday and invite them" needs a browser and the calendar specialist. meeting-debrief
   has neither, so it files a task for the principal or promises what it can't do.

A third path makes it worse. A task wake runs in the task's `source_agent_id` when that
agent pins the task tools (`resolveContinuationAgent`, `selectHeartbeatCandidates`). A
follow-up meeting-debrief files for itself therefore wakes back into meeting-debrief.
Prod, 2026-10-20/22: a booking follow-up woke in meeting-debrief twice, saved a draft to
a venue in Curia's mailbox, then closed the task noting the draft was never sent and that
it had no tool to update the calendar event.

## Decision

meeting-debrief **records** follow-up actions; the coordinator **acts** on them.

- meeting-debrief keeps the debrief itself: reading the reply, storing takeaways as KG
  facts, completing the debrief task, clearing its context bridge.
- Every action the reply asks for (email, draft, calendar event, booking, research) is
  recorded as a child task of the debrief, created with `target_agent_id: "coordinator"`
  and `wake_at` now. `task-create` already supports cross-agent ownership (#880): the
  target owns the task and receives its wakes, and `created_by` keeps the real creator.
  The scheduler polls every 30 s, so the coordinator wakes on it shortly and does it with
  its full toolset: delegate to ceo-inbox or calendar, discovery for the browser,
  `email-send`. No schema or runtime change.
- Who an email comes from is the principal's call, set once as a standing preference
  (office identity `behavioralPreferences`), which every agent and the voice runtime
  already receive. No new rules document and no tool-description cross-references.

### What the principal hears

- **The reply turn** answers the principal's message with meeting-debrief's summary,
  which says what will happen ("the follow-up to Sarah will be in your drafts shortly"),
  never that it is done.
- **The wake turn** is a scheduled run, so `SCHEDULER_DELIVERY` applies: it sends nothing
  unless its task asks. The task's progress note (task wakes carry the title and notes,
  not the description) says when to report: "Tell the principal the outcome" when it holds
  something they don't know yet (a booking's confirmed time), otherwise "Tell the principal
  only if it can't be done". A draft they asked for is silent; a booking is one message.
- **Nothing runs twice.** `task-complete` cancels a task's pending wakes, so work done
  early is not repeated. A wake left open after its turn is flagged `needs-disposition`
  (#1951) and surfaces to the principal rather than failing silently.

### Considered and rejected

- **A runtime hand-off fact** (`agent.response.handoffs` → `handed_off_tasks` in the
  delegate result, so the coordinator acts in the reply turn). One reply instead of two,
  but a new public event field and runtime plumbing to save one message, and it ties the
  reply turn up for slow work such as a browser booking. The wake reuses the scheduler.
- **A bullpen post to the coordinator.** Works (mentions start a coordinator turn), but
  the request would live in a thread and a task at once; the task is the work queue.

## Changes

1. **agents/meeting-debrief.yaml**
   - Unpin `email-draft-save`, `calendar-create-event`, `calendar-check-conflicts`.
     Keep `calendar-list-events` (detection reads the calendar).
   - Step D3: every action becomes a coordinator-owned child task waking now, its
     progress note holding the principal's words, resolved IDs and dates, and when to
     report. KG facts stay in debrief.
   - Step D4: the confirmation says what was recorded and handed off, never "done" or
     "check your drafts" for work the coordinator has not done yet.
   - Version bump (minor: pinned tools change).
2. **skills/email/tools/email-draft-save** — stays, made honest:
   - The result carries `mailbox: "curia"` (and the account name).
   - The description says the draft is in Curia's own mailbox and the principal does not
     see it.
   - The header comment's "principal reviews and sends it from their email client" goes.
3. **skills/meetings/SKILL.md:28** — a third-party follow-up after a call no longer
   names `email-draft-save`. It is asked about in the report, or done the way the
   principal asked.

## Out of scope

- **Voice.** It already receives the standing preferences (`identityBlock`), delegates
  drafts to ceo-inbox and hands sends to the coordinator through `async-offramp`.
- **The coordinator prompt.** No new always-on text.
- **Existing open follow-ups owned by meeting-debrief in prod.** List them after deploy
  and reassign any that need action to the coordinator by hand.

## Tests

- `email-draft-save` handler: the result names the mailbox.
- Scenario 32f (`debrief-reply-drafts-and-closes`): a coordinator-owned `debrief-followup`
  child task with a `wake_at`; no bullpen request.
- Scenario 15b: the coordinator's wake on a draft follow-up delegates the draft to
  ceo-inbox, completes the task, and sends nothing.
- Scenario 15c: the coordinator's wake on a booking follow-up books it through calendar
  and sends the principal exactly one message with the time.
- `prompt-budget` for meeting-debrief should shrink.
