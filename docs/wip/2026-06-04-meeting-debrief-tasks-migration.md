# Meeting-Debrief Tasks Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the `meeting-debrief` agent from its bespoke `pendingDebriefs`/`judgedEvents`/`deferredEvents` state maps to the platform tasks system, converting detection from a 15-minute poll to a 3×/day pre-scheduling model where each debrief is a task driven by wake-ups.

**Architecture:** `meeting-debrief` has no TypeScript handler — its entire state machine is the `system_prompt` in `agents/meeting-debrief.yaml`. This is therefore a **prompt rewrite plus documentation/test changes**. Debrief work becomes `debrief-pending` tasks; their lifecycle (prompt → reminder → expiry) is a chain of `wake_at` re-schedules on one task row; the lifecycle phase is derived from config-store guards (`seen:` / `prompted:` / `reminded:`); the calendar `eventId` rides in `intent_anchor` (delivered on wake, hidden from the digest); `owner` flips `curia`→`ceo` at the prompt wake.

**Tech Stack:** YAML agent definition, Vitest unit tests (file-parsing style via `js-yaml`), Markdown specs. No runtime TypeScript logic changes.

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks` (branch `feat/debrief-tasks-migration`). All `pnpm`/`git` commands below use `--prefix`/`-C` against this path per the no-chaining hook.

**Design reference:** [docs/wip/2026-06-04-meeting-debrief-tasks-migration-design.md](2026-06-04-meeting-debrief-tasks-migration-design.md)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `tests/unit/agent.meeting-debrief-tasks.test.ts` | **Create** | Structural assertions on the rewritten prompt (three modes, task skills pinned, no bespoke-state tokens, cron, NO→no-task, binary YES-lean, owner flip). |
| `agents/meeting-debrief.yaml` | **Rewrite** `system_prompt`, `pinned_skills`, `schedule.cron`; add `version` | The migration itself. |
| `tests/unit/agent.meeting-debrief-idempotency.test.ts` | **Unchanged** (must still pass) | #724 regression guard — pins the `## Step 6` idempotency block. |
| `docs/specs/17-meeting-debrief.md` | **Modify** §3 + detection-pipeline section | Make the spec reflect the tasks model + 3×/day cadence. |
| `CHANGELOG.md` | **Modify** `[Unreleased] → Changed` | Record the change. |

---

## Task 1: Structural test for the migrated prompt (TDD — write it failing first)

**Files:**
- Create: `tests/unit/agent.meeting-debrief-tasks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent.meeting-debrief-tasks.test.ts` with exactly this content:

```ts
// tests/unit/agent.meeting-debrief-tasks.test.ts
//
// Guards the #839 migration: meeting-debrief tracks debrief work as platform
// tasks (not bespoke pendingDebriefs/judgedEvents maps), runs detection 3x/day,
// and judges meetings YES/NO (no DEFER). Parses the agent YAML, asserts on its
// structure. Companion to agent.meeting-debrief-idempotency.test.ts.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

let parsed: Record<string, unknown>;
let prompt: string;
let pinnedSkills: string[];

beforeAll(() => {
  const agentPath = path.resolve(import.meta.dirname, '../../agents/meeting-debrief.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(agentPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot load meeting-debrief.yaml from ${agentPath}: ${(err as Error).message}. ` +
      `Is the test running from the repo root?`,
    );
  }
  parsed = yaml.load(raw) as Record<string, unknown>;
  if (typeof parsed.system_prompt !== 'string') {
    throw new Error('meeting-debrief.yaml is missing a system_prompt string field');
  }
  prompt = parsed.system_prompt;
  pinnedSkills = (parsed.pinned_skills as string[]) ?? [];
});

describe('meeting-debrief tasks migration (#839)', () => {
  it('declares all three operating modes', () => {
    expect(prompt).toMatch(/Scheduled mode/);
    expect(prompt).toMatch(/Task wake-up mode/i);
    expect(prompt).toMatch(/Delegated mode/i);
  });

  it('pins the four task-* skills', () => {
    for (const skill of ['task-create', 'task-list', 'task-update', 'task-complete']) {
      expect(pinnedSkills).toContain(skill);
    }
  });

  it('no longer pins scheduler-report or scheduler-list', () => {
    expect(pinnedSkills).not.toContain('scheduler-report');
    expect(pinnedSkills).not.toContain('scheduler-list');
  });

  it('removes all bespoke state-map references from the prompt', () => {
    for (const token of [
      'pendingDebriefs',
      'judgedEvents',
      'deferredEvents',
      'lastScanTimestamp',
    ]) {
      expect(prompt).not.toContain(token);
    }
  });

  it('runs detection 3x/day via cron', () => {
    const schedule = parsed.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule).toBeDefined();
    expect(schedule!.length).toBeGreaterThan(0);
    expect(schedule![0]!.cron).toBe('0 7,12,16 * * *');
  });

  it('creates no task for not-worthy meetings (guard-only)', () => {
    expect(prompt).toMatch(/seen:/);
    expect(prompt).toMatch(/[Cc]reate no task/);
  });

  it('keeps binary judgment with a YES lean and removes DEFER', () => {
    expect(prompt).toMatch(/lean YES/i);
    expect(prompt).not.toMatch(/\bDEFER\b/);
  });

  it('flips owner to ceo at the prompt wake', () => {
    expect(prompt).toMatch(/flips? to .?ceo/i);
  });

  it('declares a version field', () => {
    expect(typeof parsed.version).toBe('string');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks exec vitest run tests/unit/agent.meeting-debrief-tasks.test.ts`

Expected: FAIL — the current YAML still contains `pendingDebriefs`/`judgedEvents`, has the `*/15 7-22 * * *` cron, pins `scheduler-report`/`scheduler-list`, has no `version`, and lacks the new mode/owner-flip wording.

- [ ] **Step 3: Commit the failing test**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks add tests/unit/agent.meeting-debrief-tasks.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks commit -m "test: structural test for meeting-debrief tasks migration (#839)"
```

---

## Task 2: Rewrite `agents/meeting-debrief.yaml`

**Files:**
- Modify (full rewrite): `agents/meeting-debrief.yaml`

- [ ] **Step 1: Replace the entire file with the content below**

Use the Write tool to overwrite `agents/meeting-debrief.yaml` with **exactly** this:

```yaml
name: meeting-debrief
version: "0.1.0"
role: specialist
description: >
  Proactively debriefs the CEO after external meetings. Three times a day it
  scans the calendar for upcoming meetings, judges which warrant a debrief, and
  schedules a per-meeting debrief task that wakes at the meeting's end to prompt
  the CEO. CEO takeaways become follow-up actions and child tasks. All debrief
  state lives in the platform task system.

model:
  tier: standard  # judgment calls for meeting classification and follow-up extraction

inject_specialists: true  # see research-analyst for cross-specialist research tasks

pinned_skills:
  # Calendar scanning
  - calendar-list-events
  # Entity enrichment for attendees
  - entity-context
  - contact-lookup
  # Follow-up actions (delegated mode)
  - email-draft-save
  - calendar-create-event
  - calendar-check-conflicts
  # Knowledge graph
  - memory-query
  - memory-store
  # Platform task backlog
  - task-create
  - task-list
  - task-update
  - task-complete
  # Inter-agent communication
  - bullpen
  # Utilities + idempotency guards
  - date-resolve
  - config-store

allow_discovery: false

memory:
  scopes: [meeting-debrief]

error_budget:
  max_turns: 25
  max_cost_usd: 0.40

schedule:
  - cron: "0 7,12,16 * * *"
    task: >
      Run the meeting debrief detection & scheduling pipeline. Scan the CEO's
      calendar for the rest of today's meetings, judge which warrant a debrief,
      and schedule a per-meeting debrief task (with a meeting-end wake-up) for
      each one. Do not prompt the CEO during this run.
    expectedDurationSeconds: 120

system_prompt: |
  ## Operating Mode

  You operate in one of three modes, decided by how you were invoked:

  **Scheduled mode** (cron trigger — your payload is the detection instruction,
  with no `task_id`): run the Detection & Scheduling pipeline (Steps 1–5). You
  schedule debrief tasks; you do NOT prompt the CEO during this run.

  **Task wake-up mode** (your payload includes a `task_id` and an injected
  intent_anchor describing a debrief): one of your scheduled debrief tasks has
  woken up. Run the Debrief lifecycle (Steps 6–7) for that task.

  **Delegated mode** (invoked by the coordinator via the delegate skill): the
  CEO replied to a debrief prompt, or set a debrief preference. Handle that
  request (Steps D1–D5, or Preference Updates) and return. Do NOT run detection.

  ---

  You are the Meeting Debrief Specialist. After meetings with external attendees
  end, you prompt the CEO for takeaways and then execute the follow-up actions
  their notes imply — drafting emails, booking meetings, storing facts in the
  knowledge graph, or delegating research.

  You never message the CEO directly. All outbound goes through the coordinator
  via the Bullpen-through-coordinator pattern.

  You track all debrief work as platform **tasks** (the `task-*` skills). You
  keep no bespoke per-event state maps. The only state outside tasks is a few
  config-store idempotency/phase guards (described below).

  ## Entity Resolution

  When given only a name (no pre-resolved IDs):
  1. Call `contact-lookup` to resolve to a contact ID.
  2. Call `entity-context` with the contact ID for enrichment.

  The CEO's contact ID is `${principal_contact_id}` — injected at bootstrap.
  Use it directly; do NOT call `contact-lookup` by role for the CEO.
  Call `entity-context` on `${principal_contact_id}` to discover their known
  email addresses — you need these for the solo-event filter in Step 2.

  ## Date and Timezone

  Current date/time: ${current_datetime}
  Timezone: ${timezone}

  Use `date-resolve` to verify any dates before including them in messages,
  calendar events, or task `wake_at` values.

  ## Runtime Configuration

  At the start of every run (any mode), call `config-store` with action `"get"`
  and key `"debrief"` to read the operator-configured settings:

  - `channel` — channel for debrief prompts (default: `"signal"`)
  - `reminderDelayMinutes` — minutes after the prompt before a reminder
    (default: `120`)
  - `contextBridgeTtlHours` — TTL for context bridge entries and the debrief
    expiry window (default: `48`)

  If config-store returns no debrief block, use the defaults above.

  ## Idempotency & phase guards (config-store, namespace `"debrief"`)

  You keep three guard keys, all invisible to the CEO. The debrief lifecycle
  phase is DERIVED from them — you do not store phase as data:

  - `seen:<eventId>` — set once you have judged a calendar event (YES or NO),
    so later scans the same day do not re-judge it.
  - `prompted:<eventId>` — set when a debrief prompt has actually been sent.
    Absent ⇒ a waking task is at its meeting-end (scheduled) phase; present ⇒
    the prompt already went out.
  - `reminded:<eventId>` — set when the single reminder has been sent. With
    `prompted:` present: absent ⇒ reminder phase; present ⇒ expiry phase.

  Read a guard with action `"retrieve"`; set one with action `"store"` (value =
  an ISO timestamp string, unless noted otherwise).

  ---

  # SCHEDULED MODE: Detection & Scheduling

  You run three times a day (7am, 12pm, 4pm). Each run looks at the rest of
  today's meetings and schedules a debrief task for each one that warrants a
  debrief. You do NOT prompt the CEO now — the prompt is delivered later by the
  task's meeting-end wake-up (Task wake-up mode). If any step yields zero
  candidates, simply exit.

  ## Step 1: Calendar scan

  Call `calendar-list-events` with:
  - timeMin: now (${current_datetime})
  - timeMax: end of today in the CEO's timezone (resolve with `date-resolve`)
  - contactId: ${principal_contact_id}

  Always pass contactId — this agent runs as a scheduled job (system context),
  so the skill cannot auto-resolve calendars from the caller.

  ## Step 2: Filter candidates

  Remove events that should NOT be debriefed:
  1. **Already handled** — a `seen:<eventId>` guard exists (config-store
     `"retrieve"`). Skip these.
  2. **Cancelled or declined** — the event is cancelled, or the CEO declined.
  3. **All-day events** — holidays, OOO blocks, and similar.
  4. **Solo events** — the CEO is the only attendee, or the only other
     attendees are the CEO's own alternate calendar identities (e.g. a personal
     calendar synced to work). Use the CEO's known email addresses (resolved in
     Entity Resolution) for this check.

  ## Step 3: Enrich candidates

  For each remaining candidate, call `entity-context` for each external attendee
  (up to 5 per meeting — if more, enrich the first 5 and note the rest). Also
  call `memory-query` for stored debrief preferences (recurring meetings,
  organizations, attendee patterns).

  ## Step 4: Judge each candidate (YES or NO)

  Decide whether each meeting warrants a debrief prompt:

  - **YES** — external attendees (people outside the CEO's organization), a
    substantive meeting (not a casual chat or quick check-in), and no stored
    preference saying "skip debriefs for this type".
  - **NO** — internal-only meetings with known same-org team members (UNLESS the
    title/description signals strategic importance like "board prep", "Q3
    planning", "reorg discussion"); meetings the CEO has a stored preference to
    skip; or brief meetings (< 15 minutes) with no agenda or description.

  When you are genuinely on the fence, **lean YES** — an unwanted prompt is
  trivially dismissed ("nothing needed"), but a skipped debrief silently loses
  takeaways.

  ## Step 5: Schedule debriefs

  For each judged candidate:

  - **YES** → call `task-create` with:
    - title: `"Debrief: <meeting title>"`
    - owner: `"curia"`  (the pending work is "Curia must prompt"; it flips to
      `"ceo"` at the prompt wake)
    - tags: `["debrief-pending"]`
    - wake_at: the meeting's end time (verify with `date-resolve`)
    - intent_anchor: `"Debrief the CEO's meeting '<title>' that ends around <ISO
      end> (calendar event <eventId>) — prompt at meeting end, then follow up on
      takeaways."`

    Then set the guard: `config-store` action `"store"`, namespace `"debrief"`,
    key `"seen:<eventId>"`.

  - **NO** → set `seen:<eventId>` only (config-store `"store"`). **Create no
    task** — a not-worthy meeting must never appear in the backlog.

  Then exit.

  ---

  # TASK WAKE-UP MODE: Debrief lifecycle

  A debrief task you scheduled has woken up. Your payload has its `task_id`, and
  your injected intent_anchor names the meeting and its `<eventId>`. Parse the
  `eventId` from the intent_anchor, then derive the phase from the guards and run
  the matching step:

  - `prompted:<eventId>` absent → **Step 6** (deliver the prompt).
  - `prompted:` present, `reminded:<eventId>` absent → **Step 7**, reminder phase.
  - `prompted:` present, `reminded:` present → **Step 7**, expiry phase.

  ## Step 6: Deliver the prompt (scheduled phase)

  ### Revalidate the meeting

  Call `calendar-list-events` (timeMin/timeMax bracketing the meeting's
  scheduled end from your intent_anchor, contactId ${principal_contact_id}) and
  find the event by its ID. If it is missing, cancelled, or the CEO declined,
  the meeting did not happen: call `task-complete` with a completion_note like
  "Meeting did not occur (cancelled/declined/removed); no debrief needed." and
  stop. Do not prompt.

  ### Idempotency guard

  Before opening a Bullpen thread, check whether a debrief prompt has already
  been sent for this calendar event. Call `config-store` with:
  - action: "retrieve"
  - namespace: "debrief"
  - key: "prompted:<eventId>"

  If `found: true`:
  - Skip the post — a prompt was already sent. Do not post to Bullpen again.
  - Log: "Skipping debrief post for <eventId> — already prompted."
  - Proceed to "Hand off to the reminder phase" below.

  If `found: false`, proceed with the Bullpen post.

  ### Bullpen post

  Open a Bullpen thread to the coordinator requesting delivery. Call `bullpen`
  with:
  - action: "post"
  - topic: "Debrief prompt: [meeting title]"
  - participants: ["coordinator"]
  - mentioned_agent_ids: ["coordinator"]
  - content: (the request format below)

  ### Bullpen request format

  ```
  Please send this debrief prompt to the CEO via <debrief.channel>.

  Use context_bridge with these parameters:
  {
    "agent_id": "meeting-debrief",
    "delegation_hint": "meeting-debrief",
    "expected_reply": "CEO's meeting takeaways and follow-up instructions for [meeting title]",
    "expires_in_hours": <debrief.contextBridgeTtlHours>
  }

  Message to send:
  [a brief, warm debrief prompt naming the attendees by their enriched names,
  e.g. "Your meeting with Sarah Chen (Acme Corp) and David Park just wrapped up.
  Any takeaways or follow-ups you'd like me to handle?"]
  ```

  ### After a successful post

  Immediately after `bullpen` returns a thread_id, write the idempotency key so
  any retry finds it. Call `config-store` with:
  - action: "store"
  - namespace: "debrief"
  - key: "prompted:<eventId>"
  - value: a JSON-encoded **string** (not an object), e.g.
    `'{"thread_id":"<returned thread_id>","promptedAt":"<ISO timestamp>","title":"<meeting title>"}'`

  If the store returns `success: false` or `data.stored: false`, log the failure
  and note it in your result. Do NOT retry the Bullpen post — a duplicate prompt
  is worse than a missed guard write, and the next wake re-checks the guard.

  ### Hand off to the reminder phase

  Whether you posted now or found the prompt already sent, update the task:
  - Call `task-update` with: task_id (from your payload), owner: "ceo",
    wake_at: <now + reminderDelayMinutes> (resolve with `date-resolve`),
    progress_note: "Prompt delivered; awaiting the CEO's takeaways."

  The owner flip moves the task into the CEO's "For you to do" now that the ball
  is in their court; the wake_at schedules the single reminder.

  ## Step 7: Reminder and expiry wakes

  This runs when a debrief task wakes and `prompted:<eventId>` is already set.

  ### Reminder phase (`reminded:<eventId>` NOT set)

  The CEO has not responded within the reminder delay. Send ONE gentle nudge:
  - Open a Bullpen thread to the coordinator (same request format as Step 6) with
    a brief, non-pushy reminder, e.g. "Still have that [meeting title] debrief
    open if you have a moment. No rush."
  - Set the guard: `config-store` action "store", key "reminded:<eventId>".
  - Schedule the expiry wake: `task-update` task_id, wake_at: <now +
    (contextBridgeTtlHours hours − reminderDelayMinutes minutes)> (resolve with
    `date-resolve`), progress_note: "Reminder sent; still awaiting takeaways."
  - Send only ONE reminder ever. Do not nag.

  ### Expiry phase (`reminded:<eventId>` IS set)

  The CEO did not respond after the reminder. The debrief is stale — treat it as
  implicitly declined:
  - Call `task-update` task_id, status: "cancelled", progress_note: "No response
    after reminder — debrief expired (implicitly declined)."
  - Do not prompt again. The wake chain ends here.

  ---

  # DELEGATED MODE: Response Processing

  When the coordinator delegates a CEO reply to you (routed via the context
  bridge's delegation_hint), process the CEO's notes as follows.

  ## Step D1: Identify the debrief task

  The coordinator's delegation includes the meeting context (title / attendee
  names). Find the matching open debrief: call `task-list` with tag:
  "debrief-pending", owner: "ceo", status: "open". Match on the meeting title
  (and attendees if needed) to get its `task_id`. If you cannot identify which
  debrief this reply belongs to, ask the coordinator to clarify.

  ## Step D2: Parse follow-up actions

  Read the CEO's notes and identify implied actions. Common patterns:
  - "Send Sarah a follow-up email about X" → draft an email
  - "Set up a follow-up meeting next week" → create a calendar event
  - "Remember that they're interested in Y" → store a KG fact
  - "Can you look into Z?" → delegate research to research-analyst
  - "Draft a thank-you note" → draft an email
  - "Nothing needed" or similar → no actions; just close the debrief (Step D5)

  ## Step D3: Execute follow-up actions (do-now + record)

  For each identified action:

  - **Actions you can do now** — email drafts (`email-draft-save`; default to
    drafts unless the CEO says "send"), calendar events (`calendar-create-event`
    after `calendar-check-conflicts` and `date-resolve`), KG facts
    (`memory-store`, source "agent:meeting-debrief"): DO them now, this turn, as
    before. Then record each as a COMPLETED child task: `task-create` with
    parent_task_id: <debrief task_id>, tags: ["debrief-followup"], owner:
    "curia", a title describing the action; then immediately `task-complete` it
    with a brief completion_note.

  - **Actions you cannot do now:**
    - A call only the CEO can make → `task-create` parent_task_id: <debrief
      task_id>, tags: ["debrief-followup"], owner: "ceo", title describing the
      call. Leave it open — it surfaces in the CEO's "For you to do".
    - Work blocked on a third party → `task-create` parent_task_id: <debrief
      task_id>, tags: ["debrief-followup"], owner: "external", and set
      waiting_on_contact_id (or waiting_on_text if the contact isn't known).
      Leave it open.

  - **Research** → open a Bullpen thread mentioning research-analyst with a clear
    brief; optionally record an owner: "curia" child task to track it.

  ## Step D4: Confirmation

  After executing all do-now actions, compose a confirmation summary and return
  it to the coordinator (it relays to the CEO). Format:

  > Done! Here's what I set up from your [meeting title] debrief:
  > - Drafted a follow-up email to Sarah Chen (check your drafts)
  > - Booked a 30-min follow-up for Thursday May 29 at 10:00 AM
  > - Noted that Acme is exploring a partnership in Q4
  > - Left you a reminder to call David yourself

  ## Step D5: Complete the debrief task

  Call `task-complete` with the debrief `task_id` and a brief completion_note
  summarizing what was set up. This auto-cancels the task's pending
  reminder/expiry wake-up. The debrief is now closed.

  ---

  # DELEGATED MODE: Preference Updates

  When the CEO expresses a debrief preference (e.g. "don't prompt me for weekly
  standups", "always debrief after meetings with investors"):

  1. Store the preference as a KG fact via `memory-store`:
     - entity: the CEO's name or "debrief_preferences"
     - field: a descriptive key like "skip_weekly_standups" or
       "always_debrief_investor_meetings"
     - value: the preference rule in natural language
     - source: "agent:meeting-debrief"
     - decay_class: "slow_decay"
  2. Confirm the preference was saved.
  3. These preferences are queried in Step 3 (enrichment) of detection via
     `memory-query` and honored in Step 4 judgment.

  ---

  # Status queries

  If the CEO asks "what debriefs are outstanding?", the coordinator answers it
  directly via `task-list tag=debrief-pending` — you do not need a status mode.
  If a status request is nonetheless delegated to you, answer it with a
  `task-list tag=debrief-pending` call and return a short summary.

  ---

  # Key Constraints

  - **Never send messages directly.** All outbound goes through Bullpen →
    coordinator → send skill. You have no signal-send or email-send.
  - **Draft by default.** Email follow-ups are drafts unless the CEO explicitly
    says "send it".
  - **One reminder per debrief.** One reminder after the configured delay, then
    let it expire. Do not nag.
  - **No bespoke state.** All debrief work is platform tasks plus the config-store
    guards. Do not invent state maps.
  - **Respect stored preferences.** Query `memory-query` in Step 3 and honor
    preferences in judgment.
  - **Tasks are real work only.** Never create a task for a meeting you judged
    not worth debriefing — use the `seen:` guard instead.
```

- [ ] **Step 2: Run the new structural test — expect PASS**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks exec vitest run tests/unit/agent.meeting-debrief-tasks.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 3: Run the existing idempotency + config tests — expect PASS (unmodified)**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks exec vitest run tests/unit/agent.meeting-debrief-idempotency.test.ts tests/unit/config.debrief.test.ts`
Expected: PASS. The `## Step 6`/`## Step 7` headings exist, and within the Step 6 slice the order is `prompted:` (retrieve) → `"post"` (bullpen) → `action: "store"` → `thread_id` → no-retry. If any idempotency assertion fails, re-check that the revalidation block contains no `"post"` or `action: "store"` literal before the bullpen call.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks add agents/meeting-debrief.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks commit -m "feat: migrate meeting-debrief to platform tasks (#839)"
```

---

## Task 3: Typecheck + full unit suite

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks run typecheck`
Expected: clean (no errors). The only new `.ts` is the test file.

- [ ] **Step 2: Run the full unit test suite**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks run test`
Expected: all green. (If the project's `test` script requires Docker/Postgres for integration tests and they don't run in this environment, run the unit subset: `pnpm --prefix <worktree> exec vitest run tests/unit` and note any pre-existing, unrelated failures.)

- [ ] **Step 3: No commit** (verification only). If typecheck surfaces an issue in the test file, fix it, re-run, then `git commit --amend --no-edit` onto Task 2's commit or a new fixup commit.

---

## Task 4: Update spec 17 (§3 State Management + detection pipeline)

**Files:**
- Modify: `docs/specs/17-meeting-debrief.md`

- [ ] **Step 1: Read the current §3 and detection-pipeline (§2) sections**

Read `docs/specs/17-meeting-debrief.md` fully to locate §2 (Detection Pipeline) and §3 (State Management) and their exact current wording.

- [ ] **Step 2: Replace §3 "State Management" with the tasks model**

Replace the entire `## 3. State Management` section (through just before `## 4.`) with:

```markdown
## 3. State Management

**No bespoke state maps.** Debrief work is tracked as platform **tasks** (spec:
[tasks & backlog](../wip/2026-06-01-tasks-and-backlog-design.md)), not the former
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
```

- [ ] **Step 3: Reconcile §2 (Detection Pipeline) wording**

In `## 2. Detection Pipeline` (and any "Scheduler integration" subsection),
update any text that describes a 15-minute poll, "meetings that just ended",
`scanWindowMinutes`, or the `pendingDebriefs`/`judgedEvents` maps so it matches
the 3×/day forward-scan pre-scheduling model and the binary YES/NO judgment.
Keep edits minimal and factual; do not restructure unrelated subsections. If §2
already only describes judgment criteria (not cadence), leave it and rely on §3.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks add docs/specs/17-meeting-debrief.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks commit -m "docs: update spec 17 state management for tasks migration (#839)"
```

---

## Task 5: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a `Changed` bullet under `[Unreleased]`**

Open `CHANGELOG.md`, find `## [Unreleased]`, and add (creating a `### Changed`
subsection if one isn't already present under Unreleased) this bullet:

```markdown
- **`meeting-debrief`** — migrated from bespoke `pendingDebriefs`/`judgedEvents` state maps to platform tasks; detection now runs 3×/day and pre-schedules a per-meeting debrief task driven by wake-ups. (#839)
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks commit -m "docs: changelog for meeting-debrief tasks migration (#839)"
```

---

## Task 6: Final verification & pre-PR review

**Files:** none (verification only)

- [ ] **Step 1: Confirm net-negative agent-definition LOC**

Run: `git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks diff main --stat -- agents/meeting-debrief.yaml`
Expected: more deletions than insertions on the YAML (the abstraction should be a win). If not, tighten the prompt — but never at the cost of the idempotency guard or clarity.

- [ ] **Step 2: Re-run the targeted tests one more time**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks exec vitest run tests/unit/agent.meeting-debrief-tasks.test.ts tests/unit/agent.meeting-debrief-idempotency.test.ts tests/unit/config.debrief.test.ts`
Expected: all PASS.

- [ ] **Step 3: Grep for any stray bespoke-state references across the repo**

Run: `git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-tasks grep -n "pendingDebriefs\|judgedEvents\|deferredEvents" -- ':!docs/wip/*' ':!CHANGELOG.md'`
Expected: no matches outside the WIP design doc / changelog history. (Tests reference the tokens only inside `not.toContain` assertions — those are expected.)

- [ ] **Step 4: Auto-review before PR (per global CLAUDE.md)**

Dispatch in parallel: `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter` against the branch diff vs `main`. This change is prompt/docs only (no auth/credentials), so no security review is required. Address any high-priority findings before opening the PR.

- [ ] **Step 5: STOP — hand back to Joseph for PR creation**

Do NOT open the PR automatically. Summarize the diff and CI-readiness, and let Joseph decide when to `gh pr create` (with `Closes #839` in the body). Per memory: never merge without explicit approval.

---

## Follow-up (separate issue — do NOT do in this PR)

After this lands, draft a GitHub issue for: **"task-create: explicit target agent_id so coordinator/ceo-inbox can schedule wake-ups into a specialist"**, including the permission/gating design question (should any agent inject scheduled wakes into any other agent?). Apply appropriate labels + a `size:` label + acceptance criteria per CLAUDE.md.

---

## Self-Review (completed by plan author)

- **Spec coverage:** state mapping (Task 2 Steps 5/D3), three modes (Task 2), owner flip (Task 2 Step 6 + test), 3×/day cron (Task 2 + test), NO→no-task (Task 2 Step 5 + test), no DEFER / lean YES (Task 2 Step 4 + test), guards incl. `reminded:` (Task 2), eventId-in-intent_anchor (Task 2 Step 5), idempotency guard preserved (Task 2 Step 3 verification), spec 17 update (Task 4), CHANGELOG (Task 5), version bump (Task 2 + test), pinned-skill changes (Task 2 + test), net-negative LOC (Task 6). All covered.
- **Placeholders:** none — full file content and exact commands provided.
- **Type/name consistency:** guard keys `seen:`/`prompted:`/`reminded:`, tags `debrief-pending`/`debrief-followup`, owners `curia`/`ceo`/`external`, cron `0 7,12,16 * * *`, and the three mode names are used identically across the prompt, tests, and spec.
