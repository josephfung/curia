# Calendar Ownership Fix — Design Spec

**Date:** 2026-04-23
**Status:** Draft
**Conversation:** `kg-web-a7717246-1d7a-411c-9129-b6feb54bfc22`

## Problem

On April 23, 2026, the coordinator created a calendar event on Curia's own
calendar (`nathancuria1@gmail.com`) instead of the CEO's calendar
(`joseph@josephfung.ca`). The CEO had confirmed "Yes please" to the
coordinator's own suggestion of "Want me to put that on your calendar as a
trail walk with Donna?" — the coordinator used the right language ("your
calendar" = the CEO's) but executed against the wrong calendar.

Three compounding causes:

1. **Bad registry data.** `nathancuria1@gmail.com` is registered under the
   CEO's contact ID (`6b9c41c5-fadb-4110-a8e6-025b1a2c091e`) in the
   `contact_calendars` table. This happened on April 4 when the coordinator
   registered its own calendar during a CEO conversation about a timezone bug.
   The `calendar-register` handler defaulted the owner to `ctx.caller?.contactId`
   (the CEO) because no explicit `contact_id` was provided.

2. **Unsafe handler default.** The `calendar-register` handler
   (`skills/calendar-register/handler.ts:40-41`) defaults `contact_id` to
   `ctx.caller?.contactId` when not explicitly provided. The comment says
   "the CEO saying 'that calendar is mine'" — but the common case going
   forward will be calendars from colleagues, external contacts, or event
   feeds where defaulting to the caller is wrong.

3. **System prompt gaps.** The coordinator's system prompt
   (`agents/coordinator.yaml`) has two gaps:
   - No calendar disambiguation rules (unlike the "Inbox Disambiguation"
     section that exists for email).
   - The "Account Identity for Tool Calls" rule (lines 304-321) tells the
     coordinator to "always use your own account first" for third-party
     integrations. Calendar skills are not exempted (unlike email skills,
     which have an explicit carve-out at lines 316-321).

## Changes

### 1. Production Data Fix

Update the `contact_calendars` row for `nathancuria1@gmail.com` to point to
Curia's own contact ID instead of the CEO's.

```sql
-- Dry-run: verify current state
SELECT nylas_calendar_id, contact_id, label, is_primary
  FROM contact_calendars
 WHERE nylas_calendar_id = 'nathancuria1@gmail.com';

-- Fix: re-assign to Curia's contact
UPDATE contact_calendars
   SET contact_id = '<curia_agent_contact_id>',
       updated_at = now()
 WHERE nylas_calendar_id = 'nathancuria1@gmail.com';
```

The actual Curia agent contact ID must be looked up before running. This is
a manual operation, reviewed before execution.

### 2. Make `contact_id` Required in `calendar-register`

**File:** `skills/calendar-register/handler.ts`

Remove the `ctx.caller?.contactId` fallback on lines 40-41. Make `contact_id`
a required input. When it's missing, return a skill error:

```
Missing required input: contact_id — specify which contact owns this calendar.
```

This forces the coordinator to explicitly decide ownership before registering
any calendar. The coordinator can (and should) ask the CEO when it encounters
an unregistered calendar it can't identify.

**File:** `skills/calendar-register/skill.json`

Update the `inputs` section to mark `contact_id` as required (remove the `?`
suffix if present, or add it to the description as "required").

### 3. Add Calendar Disambiguation to System Prompt

**File:** `agents/coordinator.yaml`

Add a new "Calendar Disambiguation" section after the existing "Inbox
Disambiguation" block (~line 276). Content:

```
## Calendar Disambiguation
When the CEO references calendars, resolve as follows:

- **"my calendar"** (the CEO speaking to you directly) → the CEO's own calendar
- **"your calendar"** (the CEO speaking to you directly) → Curia's own calendar
- **Default for scheduling on behalf of the CEO** → always use the CEO's
  calendar unless the CEO explicitly says to use Curia's

When calendar-list-calendars returns an unregistered calendar, do NOT
silently register it as part of another task. Instead, flag it to the CEO:
"I see a calendar I don't recognize yet — [name]. Who does this belong to?"
Then register it with the correct contact based on their answer.
```

### 4. Add Calendar Exception to "Account Identity for Tool Calls"

**File:** `agents/coordinator.yaml`

Expand the existing exception block (lines 316-321) to include calendar
skills alongside email skills. Add after the email exception:

```
**Exception — calendar skills:** When creating, updating, or deleting events
on behalf of the CEO, use the CEO's calendar. Only use Curia's own calendar
for events that are genuinely Curia's (e.g., internal reminders, blocked time
for Curia's own tasks). When unsure which calendar to use, look up the CEO's
contact first and use their registered calendar.
```

### 5. Update Smoke Test

**File:** `tests/smoke/cases/calendar-create-event.yaml`

Add an expected behavior that the agent uses the CEO's calendar, not its own,
when creating events on behalf of the CEO:

```yaml
- id: use-ceo-calendar
  description: Creates the event on the CEO's calendar, not on Curia's own calendar
  weight: critical
```

Add a failure mode:

```yaml
- Creates the event on Curia's own calendar instead of the CEO's
```

## What This Does NOT Change

- No changes to `calendar-create-event`, `calendar-list-calendars`, or any
  other calendar skill handler — the issue is ownership data and coordinator
  behavior, not event creation logic.
- No new database tables or migrations — just updating one row in
  `contact_calendars`.
- No changes to the Nylas client or calendar data model.

## Verification

After all changes are applied:

1. `calendar-list-calendars` should show `nathancuria1@gmail.com` linked to
   Curia's contact (not the CEO's).
2. `calendar-register` should reject calls without an explicit `contact_id`.
3. The smoke test for `calendar-create-event` should include the CEO-calendar
   expectation.
4. Manual test: ask Curia to schedule an event via the web UI and confirm it
   lands on the CEO's calendar.
