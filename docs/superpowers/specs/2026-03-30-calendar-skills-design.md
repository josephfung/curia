# Calendar Skills Design

**Date:** 2026-03-30
**Status:** Proposed
**Parent plan:** `docs/plans/2026-03-29-ea-handbook-agent-plan.md` (Phase A — Calendar Agent)

## Overview

Provider-agnostic calendar management for Curia, delivered as 7 skills pinned to the
Coordinator. Uses the existing Nylas integration (same credentials as email) to support
Google Calendar, Microsoft 365/Outlook, and any other provider Nylas connects to.

The CEO's calendar is accessed as a **shared calendar** — the CEO shares their calendar
with Curia's Google account, and Nylas sees it as a shared calendar on Curia's
grant. This means no separate OAuth flow for the CEO and zero code changes if the CEO
switches providers.

### What This Covers

- CRUD operations on calendar events
- Free/busy queries across multiple calendars
- Conflict detection across accessible calendars
- Calendar discovery and registration (mapping Nylas calendar IDs to contacts)
- Contact system extension for calendar ownership

### What This Defers

- **Proactive Calendar Agent** (Phase D) — cron-triggered calendar health checks,
  overload detection, stale recurring meeting detection. Needs its own agent with an
  evaluative prompt. Depends on this work being done first.
- **Meeting Coordinator Agent** (Phase C) — multi-turn email coordination for scheduling
  with external parties whose calendars we can't see.
- **Travel time estimation** — requires a transit/directions API.
- **Calendar invitation management** — accepting/declining invites on behalf of CEO.

### Design Principles Applied

From `docs/plans/2026-03-29-ea-handbook-agent-plan.md`:

- **Skills Must Add Value Beyond the Bare LLM** — every skill here is an API bridge.
  No skill contains classification, summarization, or judgment logic. The LLM decides
  what color an event should be, whether a conflict is acceptable, what to put in a
  meeting description. The skills move data.
- **Future-Proof for LLM Upgrades** — skills provide data, context, and constraints,
  never intelligence. As models improve at multi-step reasoning, these composable
  primitives become more powerful without code changes.
- **Skills Must Compose** — skills accept raw IDs and return structured data. The LLM
  orchestrates multi-skill sequences (e.g., find free time → create event → check
  conflicts) guided by its prompt and CEO preferences.

---

## Architecture

```
Coordinator Agent
  |-- 7 calendar skills (pinned, infrastructure: true)
  |     |-- calendar-list-calendars  (discovery)
  |     |-- calendar-list-events     (read)
  |     |-- calendar-create-event    (write)
  |     |-- calendar-update-event    (write)
  |     |-- calendar-delete-event    (write)
  |     |-- calendar-find-free-time  (read)
  |     |-- calendar-check-conflicts (read)
  |     |
  |     `-- All access NylasCalendarClient via ctx
  |
  |-- NylasCalendarClient (new)
  |     |-- Wraps Nylas SDK calendar endpoints
  |     `-- Same credentials: NYLAS_API_KEY, NYLAS_GRANT_ID
  |
  `-- Contact System (extended)
        |-- contact_calendars table
        |-- Maps Nylas calendar IDs to contacts
        |-- Multiple calendars per contact
        `-- Nullable contact_id for org-wide calendars
```

### Why No Separate Agent

The original EA Handbook plan proposed a standalone Calendar Agent (specialist). After
analysis, the calendar CRUD skills are straightforward API bridges — they don't benefit
from a specialized system prompt or cognitive mode. This is consistent with how email
skills work today (pinned to the Coordinator, no Email Agent).

Benefits of keeping skills on the Coordinator:
- No delegation hop (saves an LLM turn per calendar operation)
- Coordinator already has full conversational context
- Calendar operations often interleave with email and contacts in a single conversation
- Leaning on the LLM's native reasoning means we benefit more from model upgrades

The Proactive Calendar Agent (Phase D) is a different case — it's cron-triggered with
an evaluative prompt ("review the calendar and flag problems"), which genuinely warrants
a separate agent. That's deferred.

---

## Nylas Calendar Client

**New file:** `src/channels/calendar/nylas-calendar-client.ts`

Sibling to `src/channels/email/nylas-client.ts`. Same constructor pattern: takes
`apiKey`, `grantId`, `logger`. Uses the Nylas SDK but wraps calendar endpoints.

### Methods

| Method | Nylas Endpoint | Returns |
|---|---|---|
| `listCalendars()` | `GET /calendars` | All calendars visible to the grant (owned + shared) |
| `listEvents(calendarId, timeMin, timeMax, opts?)` | `GET /events` | Events in range, with pagination |
| `createEvent(calendarId, event)` | `POST /events` | Created event |
| `updateEvent(calendarId, eventId, changes)` | `PUT /events/:id` | Updated event |
| `deleteEvent(calendarId, eventId)` | `DELETE /events/:id` | void |
| `getFreeBusy(calendarIds, timeMin, timeMax)` | `POST /calendars/free-busy` | Busy windows per calendar |

### Shared Credentials, Separate Client

No shared base class with the email NylasClient. They're independent concerns that
happen to use the same API key and grant ID. If a shared abstraction is needed later,
we extract it then.

### Bootstrap Wiring

Instantiated in `src/index.ts` alongside the existing NylasClient if Nylas credentials
are present. Passed to the ExecutionLayer so infrastructure skills access it via
`ctx.nylasCalendarClient`.

### Graceful Degradation

If Nylas credentials are missing, calendar skills are still loaded but return
`{ success: false, error: "Calendar not configured" }`. Same pattern as email today.

### Invitations

Creating an event with attendees causes Nylas/the calendar provider to send invitation
emails to those attendees automatically. This is expected behavior — when the CEO
directs the creation of an event with participants, the invitation is implicit in the
instruction. No additional confirmation gate is needed.

---

## Calendar Registry (Contact System Extension)

### Problem

Every calendar skill needs a Nylas calendar ID to operate on. The CEO says "check my
schedule" or "see if Sarah is free Thursday." The system needs to resolve natural
language references to specific calendar IDs.

### Solution

New `contact_calendars` table linking Nylas calendar IDs to contacts.

### Schema

```sql
CREATE TABLE contact_calendars (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nylas_calendar_id TEXT NOT NULL UNIQUE,
  contact_id        UUID REFERENCES contacts(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,          -- "Work", "Personal", "Board Meetings"
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  read_only         BOOLEAN NOT NULL DEFAULT false,
  timezone          TEXT,                   -- from Nylas metadata
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one primary calendar per contact
CREATE UNIQUE INDEX idx_contact_calendars_primary
  ON contact_calendars (contact_id) WHERE is_primary = true;
```

### Key Design Decisions

- **`contact_id` is nullable** — company-wide calendars (holidays, conference rooms,
  team calendars) aren't owned by a specific person.
- **`is_primary` per contact** — when the agent needs "the CEO's calendar," it picks
  the one marked primary. The partial unique index enforces at most one primary per
  contact.
- **`read_only` synced from Nylas** — reflects the permission level the calendar owner
  granted. The skill checks this before attempting writes.
- **`nylas_calendar_id` is unique** — a calendar can only be registered once.

### Resolution Logic

When a skill receives a calendar reference:

1. Agent receives natural language ("my calendar", "Sarah's calendar", "the personal one")
2. LLM resolves to a contact (via contact service) and optionally a label
3. LLM calls the skill with the resolved Nylas calendar ID
4. If the LLM can't resolve, it calls `calendar-list-calendars` to discover and asks
   the CEO for clarification

The resolution is LLM-native — no hardcoded matching logic in skill code.

### Discovery Flow

The `calendar-list-calendars` skill drives discovery:

1. Calls Nylas to list all visible calendars
2. Checks each against the `contact_calendars` registry
3. Returns the full list with registration status (linked contact + label, or
   "unregistered")
4. The Coordinator sees unregistered calendars and asks the CEO: "I can see a calendar
   called 'joseph@josephfung.ca' that I don't have on file. Who does it belong to?"
5. CEO responds naturally. The LLM calls the contact service to associate the calendar.

### Re-sync

If the CEO says "Sarah changed her email," the agent can re-run discovery. New calendars
show up as unregistered, old ones can be flagged as possibly stale. The LLM handles the
judgment; the skill handles the data plumbing.

### ContactService Extension

New methods on the existing `ContactService`:

- `linkCalendar(contactId | null, calendarData)` — associate a calendar with a contact
  (or null for org-wide calendars)
- `unlinkCalendar(nylasCalendarId)` — remove a calendar association
- `getCalendarsForContact(contactId)` — return all calendars for a contact
- `resolveCalendar(nylasCalendarId)` — return the contact (if any) for a calendar
- `getPrimaryCalendar(contactId)` — shortcut for the default calendar, returns null if
  no primary is set

---

## Skills

All skills share these properties:

- `sensitivity: "normal"` — consistent with email skills
- `infrastructure: true` — need NylasCalendarClient and ContactService via context
- Return `{ success: true, data }` or `{ success: false, error }` — never throw
- Accept raw Nylas calendar/event IDs — the LLM resolves natural language to IDs

### calendar-list-calendars (Discovery)

**Purpose:** List all calendars visible to the Nylas grant, annotated with registration
status from the contact system.

**Inputs:** *(none required)*

**Outputs:** Array of calendars, each with:
- Nylas metadata (id, name, description, timezone, is_primary, read_only,
  is_owned_by_user)
- Registry info (linked contact name + id, label) or "unregistered"

**Behavior:**
1. Call `nylasCalendarClient.listCalendars()`
2. For each calendar, query `contact_calendars` by `nylas_calendar_id`
3. Return merged list

### calendar-list-events (Read)

**Purpose:** Fetch events for a date range, with optional filtering.

**Inputs:**
- `calendarId` (string, required) — Nylas calendar ID
- `timeMin` (string, required) — ISO 8601 datetime, range start
- `timeMax` (string, required) — ISO 8601 datetime, range end
- `maxResults` (number, optional) — limit returned events
- `query` (string, optional) — case-insensitive substring filter on title and
  description
- `attendeeEmail` (string, optional) — filter to events with this attendee

**Outputs:** Array of events (title, start, end, attendees, location, description,
conferencing, status, colorId, eventId, calendarId)

**Behavior:**
1. Call `nylasCalendarClient.listEvents(calendarId, timeMin, timeMax)` with pagination
   to fetch all events in the range
2. If `query` is provided, filter to events where title or description contains the
   substring (case-insensitive)
3. If `attendeeEmail` is provided, filter to events with a matching attendee email
4. If `maxResults` is provided, truncate the result
5. Return the filtered list

The client-side filtering exists because Nylas doesn't support server-side text search
on event fields. For large ranges (e.g., "chiropractor appointments for the coming
year"), this means fetching all events and filtering locally — the skill handles the
pagination and filtering so the LLM receives only the matches.

### calendar-create-event (Write)

**Purpose:** Create a new calendar event.

**Inputs:**
- `calendarId` (string, required)
- `title` (string, required)
- `start` (string, required) — ISO 8601 datetime
- `end` (string, required) — ISO 8601 datetime
- `description` (string, optional)
- `location` (string, optional)
- `attendees` (array of `{ email, name? }`, optional) — triggers invitation emails
- `conferencing` (object, optional) — Zoom/Teams link info
- `colorId` (string, optional)
- `reminders` (object, optional)

**Outputs:** Created event object (id, title, start, end, attendees, etc.)

**Behavior:**
1. Verify the calendar is not read-only (check `contact_calendars` registry)
2. Call `nylasCalendarClient.createEvent(calendarId, eventData)`
3. Return the created event

### calendar-update-event (Write)

**Purpose:** Modify an existing calendar event.

**Inputs:**
- `calendarId` (string, required)
- `eventId` (string, required)
- Any fields to change: `title`, `start`, `end`, `description`, `location`,
  `attendees`, `conferencing`, `colorId`, `reminders` (all optional, partial update)

**Outputs:** Updated event object

**Behavior:**
1. Verify the calendar is not read-only
2. Call `nylasCalendarClient.updateEvent(calendarId, eventId, changes)`
3. Return the updated event

Attendee changes trigger invitation updates from the calendar provider.

### calendar-delete-event (Write)

**Purpose:** Remove a calendar event.

**Inputs:**
- `calendarId` (string, required)
- `eventId` (string, required)
- `notifyAttendees` (boolean, optional, default: true) — whether to send cancellation
  emails

**Outputs:** Success confirmation

**Behavior:**
1. Verify the calendar is not read-only
2. Call `nylasCalendarClient.deleteEvent(calendarId, eventId, { notifyAttendees })`
3. Return `{ success: true, data: { deleted: true } }`

### calendar-find-free-time (Read)

**Purpose:** Find available time windows across one or more calendars.

**Inputs:**
- `calendarIds` (array of strings, required) — Nylas calendar IDs to check
- `timeMin` (string, required) — ISO 8601 datetime, search range start
- `timeMax` (string, required) — ISO 8601 datetime, search range end
- `duration` (number, optional) — minimum window size in minutes

**Outputs:** Array of free windows (`{ start, end }`) across all specified calendars

**Behavior:**
1. Call `nylasCalendarClient.getFreeBusy(calendarIds, timeMin, timeMax)`
2. Compute free windows by inverting the busy periods
3. If `duration` is provided, filter to windows at least that long
4. Return the free windows

Accepts multiple calendar IDs for queries like "when are both the CEO and CFO free
this week?"

### calendar-check-conflicts (Read)

**Purpose:** Check whether a proposed time slot conflicts with existing events.

**Inputs:**
- `calendarIds` (array of strings, required) — Nylas calendar IDs to check
- `proposedStart` (string, required) — ISO 8601 datetime
- `proposedEnd` (string, required) — ISO 8601 datetime

**Outputs:** Array of conflicting events (`{ calendarId, contactName, title, start,
end }`) or empty array if the time is clear

**Behavior:**
1. Call `nylasCalendarClient.getFreeBusy(calendarIds, proposedStart, proposedEnd)`
2. For each busy period that overlaps the proposed range, fetch the event details
3. Annotate each conflict with the calendar owner's name (from the registry)
4. Return the list

Returns the conflicting events (not just yes/no) so the LLM can reason about severity
— a hard conflict vs. a tentative hold vs. an all-day reminder.

---

## What the Skills Don't Do

Per the "Skills Must Add Value Beyond the Bare LLM" principle, these operations are
deliberately left to the LLM:

- **Decide what color an event should be** — CEO preferences in the KG inform the LLM
- **Determine if a conflict is acceptable** — the LLM weighs severity, importance, flexibility
- **Compose meeting descriptions or agendas** — LLM-native text generation
- **Choose whether to reschedule vs. cancel** — judgment call
- **Create travel time blocks** — the LLM calls `calendar-create-event` with appropriate defaults
- **Create focus time blocks** — same: `calendar-create-event` with the right parameters
- **Evaluate calendar health or overload** — deferred to Proactive Calendar Agent (Phase D)

---

## Error Handling

Follows existing Curia patterns — nothing novel:

- **Nylas API errors** — `{ success: false, error: "<meaningful message>" }`. Skills
  never throw.
- **Calendar not configured** — `{ success: false, error: "Calendar not configured" }`.
  Returned when Nylas credentials are missing.
- **Calendar not found** — `{ success: false, error: "Calendar <id> not found" }`.
- **Permission denied** — `{ success: false, error: "Calendar is read-only" }`.
  Checked against the registry's `read_only` flag before attempting writes.
- **Token/auth failures** — Nylas SDK handles token refresh internally. If the grant is
  revoked, the SDK returns an auth error which the skill surfaces as a failure.
- **Rate limiting** — Return error. The framework's error recovery (spec 05) handles
  retries with backoff.

No custom retry logic in the calendar skills. The framework's error budget system
already handles transient failures.

---

## Testing Strategy

### Unit Tests

- **NylasCalendarClient:** Mock the Nylas SDK. Verify correct API calls and response
  mapping for each method. Test pagination handling in `listEvents`.
- **Each skill handler:** Mock NylasCalendarClient. Verify:
  - Input validation (missing required fields)
  - Client-side filtering logic (`query`, `attendeeEmail` in `list-events`)
  - Read-only calendar checks for write skills
  - Error handling paths (missing calendar, API errors, no credentials)
- **ContactService calendar methods:** Real Postgres (existing test pattern). Verify:
  - `linkCalendar` / `unlinkCalendar` CRUD operations
  - `getPrimaryCalendar` returns the right one
  - `is_primary` uniqueness constraint per contact
  - Nullable `contact_id` for org-wide calendars
  - Cascade delete when contact is removed

### Integration Tests

Skills wired through the execution layer with mocked Nylas responses. Verify the full
path: skill invocation -> context injection -> client call -> response mapping.

### No Live API Tests in CI

Nylas calls are mocked in all automated tests. Manual testing against a real calendar
during development.

---

## Bootstrap Sequence (Additions)

No new environment variables. The existing `NYLAS_API_KEY` and `NYLAS_GRANT_ID` cover
calendar access — same grant, same credentials. The Nylas grant must have been set up
with calendar scopes.

### New Steps in `src/index.ts`

After step 8 (Email/Nylas Channel):

```
8.5  NylasCalendarClient (if Nylas credentials present)
       Same apiKey + grantId as email client
       Independent instance, no shared state with email client
```

After step 9 (Skill System):

```
9.5  Contact System — calendar registry
       Migration adds contact_calendars table
       New methods on ContactService
```

The NylasCalendarClient is passed to the ExecutionLayer alongside existing
infrastructure services. Infrastructure skills access it via `ctx.nylasCalendarClient`.

### SkillContext Extension

The `SkillContext` interface (`src/skills/types.ts`) gains a new optional field:

```typescript
nylasCalendarClient?: NylasCalendarClient;
```

Available only to infrastructure skills, same pattern as `outboundGateway`,
`contactService`, etc. The ExecutionLayer injects it when building the context.

### Config

New derived field in `Config`: `nylasCalendarEnabled` (boolean). True if Nylas
credentials are present. No separate toggle — if you have Nylas, you have calendar.

### Coordinator Prompt

Minimal additions to `agents/coordinator.yaml` system prompt — a brief section noting
that calendar skills are available and that calendars are managed via the contact
system's calendar registry. The LLM handles the rest. Skill descriptions in the
manifests are sufficient for the LLM to pick the right tool.

---

## Migration

One new migration file:

```
src/db/migrations/XXX_add-contact-calendars.sql
```

Creates the `contact_calendars` table and partial unique index as defined in the
Calendar Registry section above.
