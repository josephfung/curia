# Calendar Specialist Agent — Design Spec

## Context

`coordinator.yaml` currently owns all calendar reasoning: 8 pinned calendar skills, a
disambiguation section for pronoun resolution, an account identity exception for calendar
operations, a Scheduling Behavior section with meeting-proposal rules, and 3 template-*
skills for scheduling email composition. This is ~45 lines of prompt + 11 pinned skills
that form a coherent scheduling domain.

This spec carves the calendar domain into its own specialist agent, following the same
delegation model established by the contacts specialist (#498): coordinator passes intent +
resolved entities, specialist owns execution and returns rich text for the coordinator to
synthesize.

Additionally, the 3 template-* skills (`template-meeting-request`, `template-reschedule`,
`template-cancel`) become redundant — the calendar specialist composes scheduling email
text directly with full scheduling context, eliminating the need for separate template skills.

Closes josephfung/curia#499.

---

## 1. Agent Definition

**File:** `agents/calendar.yaml` (new file in curia core)

```yaml
name: calendar
role: specialist
description: >
  Calendar domain specialist — scheduling, free/busy, conflict resolution,
  event CRUD, and scheduling-related email composition for meeting requests,
  reschedules, and cancellations
model:
  provider: anthropic
  model: claude-sonnet-4-6
allow_discovery: false
```

No `schedule:` block — calendar-related cron jobs are created dynamically via
`scheduler-create` and flow through the coordinator, which delegates to the
calendar specialist as needed.

No `memory:` scopes defined — the specialist uses the default memory access
via `memory-query` and `memory-store` for scheduling preferences.

---

## 2. System Prompt Structure

### 2.1 Role

The Calendar Specialist owns the full calendar domain. The coordinator delegates
all scheduling intelligence to it. It never communicates directly with external
parties — all responses go back to the coordinator for synthesis and delivery.

### 2.2 Entity Resolution

The specialist resolves entities in-turn using pinned `contact-lookup` and
`entity-context` skills:

- When the coordinator passes `<resolved_entities>` from a prior contacts
  briefing, use those IDs directly — don't re-resolve
- When given only a name, resolve: `contact-lookup` -> `entity-context` ->
  registered calendar IDs from the entity context
- For the agent's own calendar: use `${agent_contact_id}` directly

### 2.3 Calendar Disambiguation

Migrated from coordinator (lines 362-375), adapted for specialist context:

- "my calendar" (CEO speaking) -> the CEO's calendar
- "your calendar" (CEO speaking to the agent) -> the agent's calendar
- "Curia's calendar" -> the agent's calendar
- Default for scheduling on behalf of the CEO -> CEO's calendar unless
  explicitly stated otherwise
- To find the CEO's calendar: resolve CEO via contact-lookup, then use
  entity-context to get their registered calendar IDs

### 2.4 Account Identity for Calendar Skills

Migrated from coordinator (lines 434-438):

- When creating/updating/deleting events on behalf of the CEO, use the
  CEO's calendar
- Only use the agent's own calendar for genuinely agent-owned events
  (internal reminders, blocked time for agent tasks)
- When unsure which calendar, look up the CEO's contact first and use
  their registered calendar

### 2.5 Scheduling Intelligence

Migrated from coordinator Scheduling Behavior (lines 377-395) + expanded:

**Core rules:**
1. Be specific -- always propose concrete date AND time (e.g., "Monday May 18
   at 10:30 AM"). Never say "before 2pm" or "in the morning" -- pick a slot.
2. Offer alternatives -- propose a primary time and one backup on a different
   day. Two options reduces round-trips without overwhelming.
3. Respect constraints -- if the other party stated bounds (e.g., "Mon/Wed/Fri
   before 2pm"), only propose times within those bounds.
4. Verify dates -- call `date-resolve` to confirm every date + day-of-week
   pair before writing it. Never write "Monday May 19" without confirming.
5. Defaults -- 30-minute meetings unless context suggests otherwise. Prefer
   mid-morning (9:30-11:30 AM) when no time preference is stated.

**Expanded capabilities (new):**
- Multi-party slot finding: when scheduling with 2+ people, find free time
  across all their calendars simultaneously using `calendar-find-free-time`
- Preference-sensitive scheduling: before proposing times, check `memory-query`
  for stored scheduling preferences (faith observances, standing blocked times,
  preferred meeting lengths, timezone preferences)
- Timezone awareness: when scheduling across timezones, state times in each
  participant's local timezone

### 2.6 Preference Hierarchy

The CEO provides scheduling rules dynamically via chat or email (e.g., "no
meetings before 10am", "always make meetings 45 minutes", "I don't take
calls on Fridays"). These override system prompt defaults.

**Resolution order (highest wins):**

1. **Current-task instruction** -- explicit constraint in the coordinator's
   delegation for this specific task (e.g., "make it 15 minutes"). Applied
   immediately, not stored.
2. **Stored preferences** -- CEO-provided rules saved in the knowledge graph
   via `memory-store`. The specialist queries these proactively via
   `memory-query` before every scheduling task. Examples: preferred meeting
   length, blocked days/times, faith observances, timezone preferences.
3. **System prompt defaults** -- the fallback when no stored preference or
   current-task instruction applies (e.g., 30-minute meetings, mid-morning
   preference).

**How preferences reach the specialist:**

The coordinator handles "remember that..." commands and stores them via
`memory-store` (this flow doesn't change). The specialist then picks them
up via `memory-query` before scheduling. The specialist does not need to
store preferences itself -- it reads what the coordinator (or contacts
specialist) has already stored.

When a stored preference contradicts a system prompt default, the stored
preference wins silently. When a current-task instruction contradicts a
stored preference, the task instruction wins -- but the specialist should
note the deviation in its response so the coordinator can confirm with the
CEO if appropriate (e.g., "I scheduled a 15-minute meeting as requested --
note that your usual preference is 45 minutes").

### 2.7 Conflict Escalation

When a proposed time conflicts with existing events:
- Report the conflict clearly: "I found a conflict with [event title] at
  that time"
- Propose alternatives: offer 2 slots that work
- Let the coordinator decide whether to move the conflicting event or
  pick a different slot
- When modifying an event would create a cascade (e.g., moving a meeting
  that other meetings depend on), flag the chain reaction

### 2.8 Unregistered Calendar Handling

When `calendar-list-calendars` surfaces an unregistered calendar during any
operation:
- Do NOT silently register it
- Flag it in the response using a `<needs_input>` block:
  ```
  <needs_input type="unregistered_calendar" calendar_name="..." nylas_id="..."/>
  ```
- The coordinator surfaces the question to the CEO
- Once the CEO identifies the owner, the coordinator delegates back with the
  contact to register to

### 2.9 Calendar Registration Guidance

When asked to register a calendar:
- Use `calendar-register` with the provided contact_id
- If `is_primary` isn't specified and the contact already has a primary
  calendar, default to `is_primary: false`
- On unique constraint violations, explain the situation clearly

### 2.10 Scheduling Email Composition

When the coordinator's delegation implies email is needed (e.g., "Find a time
and draft a meeting request to Sarah"):
- Compose the email text as part of the response
- Return it in a `<scheduling_email>` block:
  ```
  <scheduling_email subject="Meeting: [topic]">
  [composed email body]
  </scheduling_email>
  ```
- The coordinator uses this text with its email skills to send
- Tone: professional, specific, ready for the coordinator to adapt to the
  CEO's voice via `${executive_voice_block}`
- Cover meeting requests, reschedules, and cancellations -- this replaces
  `template-meeting-request`, `template-reschedule`, and `template-cancel`

### 2.11 Memory -- Proactive Recall

Before scheduling tasks involving known people or entities:
- Query `memory-query` for scheduling preferences, timezone info, standing
  blocked times, faith observances, meeting-length preferences
- Let stored context shape the proposal (e.g., "Sarah prefers morning
  meetings" -> propose 10 AM, not 3 PM)
- Surface recalled context silently -- don't announce "I checked memory"
- If nothing is found, proceed with defaults

---

## 3. Pinned Skills

```yaml
pinned_skills:
  # Calendar CRUD
  - calendar-list-calendars
  - calendar-register
  - calendar-list-events
  - calendar-create-event
  - calendar-update-event
  - calendar-delete-event
  - calendar-find-free-time
  - calendar-check-conflicts
  # Entity resolution
  - contact-lookup
  - entity-context
  # Date verification
  - date-resolve
  # Context
  - memory-query
  - memory-store
  # Cross-specialist consultation
  - bullpen
```

16 pinned skills total.

---

## 4. Coordinator Changes

### 4.1 Sections Removed

| Section | Lines | Description |
|---------|-------|-------------|
| Calendar Disambiguation | 362-375 (~14 lines) | Pronoun resolution for calendar references |
| Scheduling Behavior | 377-395 (~19 lines) | Meeting proposal rules |
| Calendar account identity exception | 434-438 (~5 lines) | "Use CEO's calendar for calendar skills" |

~38 lines removed from system prompt.

### 4.2 Skills Removed from pinned_skills

8 calendar skills:
- `calendar-list-calendars`
- `calendar-register`
- `calendar-list-events`
- `calendar-create-event`
- `calendar-update-event`
- `calendar-delete-event`
- `calendar-find-free-time`
- `calendar-check-conflicts`

3 template skills (retired):
- `template-meeting-request`
- `template-reschedule`
- `template-cancel`

11 skills removed total.

### 4.3 Section Added

General pronoun-resolution rule (~3 lines), placed near the existing
"Your Identity" section:

> Before delegating to any specialist, resolve first-person and possessive
> pronouns to explicit entity identities based on who is speaking. "My
> calendar" from the CEO means the CEO's calendar. "Your calendar"
> addressed to you means your calendar. "Their schedule" referring to a
> third party means that person's calendar. Apply this rule for all
> specialist delegations, not just calendar.

### 4.4 Coordinator `date-resolve`

The coordinator **keeps** `date-resolve` in its pinned_skills -- it has
non-calendar uses (e.g., "what day of the week is May 19?").

### 4.5 Net Impact

- ~38 lines removed from system prompt, ~3 lines added -> **net ~35 lines reduced**
- 11 skills removed from pinned_skills -> cleaner, more focused coordinator

---

## 5. Contacts Specialist Changes

### 5.1 TODO Resolution

The TODO comment at lines 76-79 of `agents/contacts.yaml`:
```
<!-- @TODO: When a calendar specialist is carved out...
     See josephfung/curia#498. -->
```

Resolve this: the contacts specialist **keeps** `calendar-list-events` as a
direct read-only pin for meeting history enrichment in briefings. This was
confirmed during design -- shared read-only skills are fine.

Replace the TODO with a brief comment explaining the decision:
```
<!-- Calendar specialist owns the calendar domain. contacts keeps
     calendar-list-events as a direct read-only pin for meeting history
     enrichment -- no cross-agent hop needed for read-only access. -->
```

### 5.2 Second TODO

The TODO at lines 205-207:
```
# @TODO: When a calendar specialist is carved out, revisit whether this moves there.
```

Same resolution -- replace with:
```
# Calendar specialist owns the domain; contacts keeps this read-only pin for briefing enrichment.
```

---

## 6. Template Skills Retirement

The following skills are retired and deleted:

- `skills/template-meeting-request/`
- `skills/template-reschedule/`
- `skills/template-cancel/`
- `tests/unit/skills/template-meeting-request.test.ts`

The calendar specialist composes scheduling email text directly in its
delegation response, with full scheduling context (proposed times, conflicts,
constraints, preferences). This produces better email text than templates
that receive only structured inputs.

**Doc references to update:**
- `docs/dev/adding-an-agent.md` (line 165) -- remove the 3 retired templates
  from the skill reference table. Keep `template-doc-request` (not retired).
- `docs/specs/03-skills-and-execution.md` (line 185) -- update the skill list
  to note that template scheduling skills were replaced by the calendar specialist.

---

## 7. Compound Task Flow

Example: "Draft a meeting request to Sarah Johnson and create the calendar invite"

**Before (two separate flows):**
1. Coordinator calls template-meeting-request -> gets email text
2. Coordinator calls calendar-create-event -> creates event
3. Coordinator sends email + confirms event

**After (one delegation):**
1. Coordinator briefs contacts specialist on Sarah -> gets `<resolved_entities>`
2. Coordinator delegates to calendar specialist: "Find a 30-minute slot with
   Sarah Johnson (contact_id: abc-123) this week. Create the event and draft
   a meeting request email."
3. Calendar specialist:
   - Resolves Sarah's calendar via entity-context
   - Finds free time across both calendars
   - Creates the event
   - Composes meeting request email text
   - Returns summary + `<scheduling_email>` block
4. Coordinator sends the email using email-send

One delegation hop, all scheduling intelligence in one place.

---

## 8. Verification Plan

### 8.1 Smoke Tests (from acceptance criteria)

- [ ] List events: delegate "What's on the CEO's calendar today?"
- [ ] Create event (single-party): delegate "Block 2pm-3pm Thursday for focus time"
- [ ] Create event (multi-party): delegate "Schedule a 30-minute meeting with Sarah Johnson next week"
- [ ] Find free time: delegate "When is the CEO free this week?"
- [ ] Check conflicts: delegate "Can the CEO do 2pm Tuesday?"
- [ ] Delegation from coordinator: send "What's on my calendar tomorrow?" via CLI
- [ ] Compound task: "Draft a meeting request to Sarah and create the invite"
- [ ] Unregistered calendar: specialist returns `<needs_input>` block

### 8.2 Coordinator Regression

- [ ] Coordinator no longer has calendar skills pinned
- [ ] Template skills no longer exist
- [ ] General pronoun-resolution rule works for non-calendar delegations
- [ ] `date-resolve` still works directly from coordinator

### 8.3 Contacts Specialist

- [ ] Contacts specialist still uses calendar-list-events for meeting history in briefings

---

## 9. Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `agents/calendar.yaml` | **Create** | New calendar specialist agent definition |
| `agents/coordinator.yaml` | **Modify** | Remove calendar sections + skills, add pronoun rule |
| `agents/contacts.yaml` | **Modify** | Resolve TODO comments (2 locations) |
| `skills/template-meeting-request/` | **Delete** | Retired |
| `skills/template-reschedule/` | **Delete** | Retired |
| `skills/template-cancel/` | **Delete** | Retired |
| `tests/unit/skills/template-meeting-request.test.ts` | **Delete** | Test for retired skill |
| `docs/dev/adding-an-agent.md` | **Modify** | Remove retired templates from skill table |
| `docs/specs/03-skills-and-execution.md` | **Modify** | Update skill list |
| `CHANGELOG.md` | **Modify** | Add entries under [Unreleased] |
