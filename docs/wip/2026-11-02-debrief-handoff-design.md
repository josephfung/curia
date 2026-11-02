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
  recorded as a child task of the debrief, created with `target_agent_id: "coordinator"`.
  `task-create` already supports this (#880): the target owns the task and receives its
  wakes, and `created_by` keeps the real creator. No schema change.
- The coordinator works those tasks like any other request, with its full toolset:
  delegate to ceo-inbox or calendar, discovery for the browser, `email-send`.
- Who an email comes from is the principal's call, set once as a standing preference
  (office identity `behavioralPreferences`), which every agent and the voice runtime
  already receive. No new rules document and no tool-description cross-references.

### When the follow-ups run

Follow-up actions come only from the principal's reply, which reaches meeting-debrief by
delegation; its scheduled runs only detect meetings and prompt. So the child tasks carry no
`wake_at`: the delegate result lists them and the coordinator works them in the same turn.
If the delegation outlives its wait, the late-result brief lists them the same way. The
heartbeat (4 h idle, owner `curia`) is the backstop for one left open. No `wake_at` also
means a follow-up is never run twice, once in the turn and again by its wake.

The self-owned follow-ups that used to wake back into meeting-debrief are no longer
created.

### Delegate result

The runtime records the hand-offs of each run on `agent.response.handoffs`, the way it
records `sends` (#2055): every successful `task-create` by a specialist with
`target_agent_id: "coordinator"`, as `{ task_id, title, description? }`. Recording them from
the run's own tool calls keeps a concurrent run of the same specialist out of the result.
`shapeSpecialistAnswer` turns them into `handed_off_tasks` plus a `next_step` telling the
coordinator to do them now, complete each one, and report from its own results. Both the
delegate result and the late-result brief use it. This is code with its trigger (ADR-046),
not coordinator prompt text, and it works for any specialist that hands off this way.

## Changes

1. **agents/meeting-debrief.yaml**
   - Unpin `email-draft-save`, `calendar-create-event`, `calendar-check-conflicts`.
     Keep `calendar-list-events` (detection reads the calendar).
   - Step D3: every action becomes a coordinator-owned child task (above). Remove the
     "actions you can do now" path for email and calendar. KG facts stay in debrief.
   - Step D4: the confirmation says what was recorded and handed off, never "done" or
     "check your drafts" for work the coordinator has not done yet.
   - Version bump (minor: pinned tools change).
2. **Runtime and delegate** — `agent.response.handoffs` (src/agents/task-handoffs.ts),
   `handed_off_tasks` plus its `next_step` in the delegate result and the late-result brief.
3. **skills/email/tools/email-draft-save** — stays, made honest:
   - The result carries `mailbox: "curia"` (and the account name).
   - The description says the draft is in Curia's own mailbox and the principal does not
     see it.
   - The header comment's "principal reviews and sends it from their email client" goes.
4. **skills/meetings/SKILL.md:28** — a third-party follow-up after a call no longer
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
- Runtime: `handoffs` lists only successful coordinator-targeted `task-create` calls.
- `delegate` handler and late brief: `handed_off_tasks` and its `next_step`, only when
  non-empty.
- Scenario 32f (`debrief-reply-drafts-and-closes`): now asserts a coordinator-owned
  `debrief-followup` child task, and no `email-draft-save`.
- New scenario 15b: a debrief reply asking for a draft ends with the coordinator
  delegating the draft to ceo-inbox, no `email-draft-save`, no `email-send`. Running it is paid: a
  targeted run with a cost estimate first.
- `prompt-budget` for meeting-debrief should shrink.
