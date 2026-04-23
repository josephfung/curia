# Calendar Ownership Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the calendar ownership bug where Curia creates events on its own calendar instead of the CEO's, and prevent it from recurring.

**Architecture:** Data fix in prod + handler change to require explicit `contact_id` + system prompt additions for calendar disambiguation and account identity exceptions + smoke test update.

**Tech Stack:** TypeScript (handler), YAML (coordinator prompt, smoke test), SQL (prod data fix)

**Design spec:** `docs/wip/2026-04-23-calendar-ownership-design.md`

---

### Task 1: Make `contact_id` Required in `calendar-register` Handler

**Files:**
- Modify: `skills/calendar-register/handler.ts:38-52`
- Modify: `skills/calendar-register/skill.json:12`

- [ ] **Step 1: Update the handler to require `contact_id`**

In `skills/calendar-register/handler.ts`, replace lines 38-52 (the `resolvedContactId` block) with a required-input check:

```typescript
    // contact_id is required — the coordinator must explicitly specify which
    // contact owns this calendar. This prevents silent mis-assignment when the
    // caller (e.g. the CEO) is not the calendar's actual owner.
    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id — specify which contact owns this calendar.' };
    }

    const resolvedContactId = contact_id;
```

Also update the file header comment (lines 1-11). Replace:
```
// contact_id defaults to the caller's own contact when omitted — the common case
// when the CEO is claiming ownership of their own calendar.
```
with:
```
// contact_id is required — the coordinator must always specify which contact
// owns the calendar. This prevents silent mis-assignment (see incident
// kg-web-a7717246-1d7a-411c-9129-b6feb54bfc22).
```

- [ ] **Step 2: Update the skill manifest to mark `contact_id` as required**

In `skills/calendar-register/skill.json`, change `contact_id` from optional to required. Replace:
```json
    "contact_id": "string?",
```
with:
```json
    "contact_id": "string (required — which contact owns this calendar)",
```

Also update the skill `description` to remove the defaulting language. Replace:
```json
  "description": "Register a Nylas calendar in the contact registry, linking it to a contact. Use this after calendar-list-calendars identifies an unregistered calendar and the CEO confirms which contact it belongs to. Defaults contact_id to the caller's own contact when omitted — the common case when the CEO is claiming their own calendar.",
```
with:
```json
  "description": "Register a Nylas calendar in the contact registry, linking it to a contact. Use this after calendar-list-calendars identifies an unregistered calendar and the CEO confirms which contact it belongs to. Always requires an explicit contact_id — ask the CEO who owns the calendar if unsure.",
```

- [ ] **Step 3: Run the existing tests to see which ones break**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/skills/calendar-register.test.ts`

Expected: Two tests should now fail:
- `defaults contact_id to the caller when not provided` — this tested the old defaulting behavior
- `uses null contact_id when no contact_id and no caller` — this tested the org-wide fallback

- [ ] **Step 4: Update the failing tests**

In `tests/unit/skills/calendar-register.test.ts`:

Replace the test `defaults contact_id to the caller when not provided` (lines 89-117) with:

```typescript
  it('returns failure when contact_id is missing', async () => {
    const contactService = { linkCalendar: vi.fn() };
    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-1', label: 'Personal', is_primary: true },
        {
          contactService: contactService as never,
          caller: { contactId: 'caller-contact', role: 'ceo', channel: 'email' },
        },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('contact_id');
    }
    // Crucially: linkCalendar should NOT have been called
    expect(contactService.linkCalendar).not.toHaveBeenCalled();
  });
```

Replace the test `uses null contact_id when no contact_id and no caller` (lines 119-144) with:

```typescript
  it('returns failure when contact_id is missing even without caller context', async () => {
    const contactService = { linkCalendar: vi.fn() };
    const result = await handler.execute(
      makeCtx(
        { nylas_calendar_id: 'cal-holidays', label: 'Holidays' },
        { contactService: contactService as never },
      ),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('contact_id');
    }
    expect(contactService.linkCalendar).not.toHaveBeenCalled();
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/skills/calendar-register.test.ts`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add skills/calendar-register/handler.ts skills/calendar-register/skill.json tests/unit/skills/calendar-register.test.ts
git -C /path/to/worktree commit -m "fix: require explicit contact_id in calendar-register

The handler previously defaulted to ctx.caller?.contactId when contact_id
was omitted, which caused Curia's own calendar to be registered under the
CEO's contact during a CEO conversation. Now requires the coordinator to
always specify which contact owns the calendar."
```

---

### Task 2: Add Calendar Disambiguation to Coordinator System Prompt

**Files:**
- Modify: `agents/coordinator.yaml:277` (insert after Inbox Disambiguation section)

- [ ] **Step 1: Add the Calendar Disambiguation section**

In `agents/coordinator.yaml`, insert the following block after line 276 (the last line of the "Inbox Disambiguation" section, ending with `Curia has no access to it — decline or ask the CEO to clarify`), and before line 278 (`## Observation Mode — Monitored Inboxes`):

```yaml

  ## Calendar Disambiguation
  When the CEO references calendars, resolve as follows:

  - **"my calendar"** (the CEO speaking to you directly) → the CEO's own calendar
  - **"your calendar"** (the CEO speaking to you directly) → Curia's own calendar
  - **Default for scheduling on behalf of the CEO** → always use the CEO's
    calendar unless the CEO explicitly says to use Curia's

  When calendar-list-calendars returns an unregistered calendar, do NOT silently
  register it as part of another task. Instead, flag it to the CEO: "I see a
  calendar I don't recognize yet — [name]. Who does this belong to?" Then
  register it with the correct contact based on their answer.

```

- [ ] **Step 2: Verify the YAML is valid**

Run: `node -e "const fs = require('fs'); const yaml = require('js-yaml'); yaml.load(fs.readFileSync('/path/to/worktree/agents/coordinator.yaml', 'utf8')); console.log('YAML valid')"`

If `js-yaml` isn't available, use: `npx js-yaml /path/to/worktree/agents/coordinator.yaml > /dev/null`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add agents/coordinator.yaml
git -C /path/to/worktree commit -m "fix: add Calendar Disambiguation to coordinator prompt

Parallel to the existing Inbox Disambiguation section. Clarifies that
scheduling on behalf of the CEO defaults to the CEO's calendar, and that
unregistered calendars should be flagged to the CEO rather than silently
registered."
```

---

### Task 3: Add Calendar Exception to "Account Identity for Tool Calls"

**Files:**
- Modify: `agents/coordinator.yaml:321` (insert after the email exception block)

- [ ] **Step 1: Add the calendar exception**

In `agents/coordinator.yaml`, find the end of the email exception block (line 321, ending with `it applies only to third-party tools where you're picking an acting identity.`). Insert the following immediately after:

```yaml

  **Exception — calendar skills:** When creating, updating, or deleting events
  on behalf of the CEO, use the CEO's calendar. Only use Curia's own calendar
  for events that are genuinely Curia's (e.g., internal reminders, blocked time
  for Curia's own tasks). When unsure which calendar to use, look up the CEO's
  contact first and use their registered calendar.
```

Note: line numbers may have shifted after Task 2's insertion. Find the anchor text `it applies only to third-party tools where you're picking` and insert after the line that ends that paragraph.

- [ ] **Step 2: Verify the YAML is valid**

Run the same YAML validation as Task 2 Step 2.

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add agents/coordinator.yaml
git -C /path/to/worktree commit -m "fix: add calendar exception to Account Identity for Tool Calls

Calendar writes on behalf of the CEO should target the CEO's calendar,
not Curia's. This mirrors the existing email exception."
```

---

### Task 4: Update Smoke Test

**Files:**
- Modify: `tests/smoke/cases/calendar-create-event.yaml`

- [ ] **Step 1: Add CEO-calendar expected behavior and failure mode**

In `tests/smoke/cases/calendar-create-event.yaml`, add the following entry to `expected_behaviors` (after the last existing entry):

```yaml
  - id: use-ceo-calendar
    description: Creates the event on the CEO's calendar, not on Curia's own calendar
    weight: critical
```

Add the following entry to `failure_modes` (after the last existing entry):

```yaml
  - Creates the event on Curia's own calendar instead of the CEO's
```

- [ ] **Step 2: Verify the YAML is valid**

Run: `npx js-yaml /path/to/worktree/tests/smoke/cases/calendar-create-event.yaml > /dev/null`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add tests/smoke/cases/calendar-create-event.yaml
git -C /path/to/worktree commit -m "fix: add CEO-calendar expectation to calendar-create-event smoke test

Ensures the agent uses the CEO's calendar when scheduling on their behalf,
catching regressions like the trail-walk incident."
```

---

### Task 5: Production Data Fix

This task is executed manually against the production database, **not** in the worktree. The implementer should draft the SQL and present it for review before execution.

**Files:**
- None (manual SQL against prod)

- [ ] **Step 1: Look up Curia's agent contact ID**

SSH into prod and query:

```bash
ssh -i ~/.ssh/ceo_office_vps -p 2222 -o IdentitiesOnly=yes ceo@204.168.176.150 \
  "docker exec curia-postgres-1 psql -U curia -d curia -c \
  \"SELECT contact_id, display_name, role FROM contacts WHERE display_name ILIKE '%curia%' OR role = 'agent' ORDER BY created_at ASC;\""
```

If that doesn't find it, check the config or the `agent_contact_id` injection in the codebase. The goal is to find the contact ID that represents Curia itself (not the CEO's contact `6b9c41c5-fadb-4110-a8e6-025b1a2c091e`).

- [ ] **Step 2: Verify current state**

```sql
SELECT nylas_calendar_id, contact_id, label, is_primary
  FROM contact_calendars
 WHERE nylas_calendar_id = 'nathancuria1@gmail.com';
```

Expected: `contact_id` = `6b9c41c5-fadb-4110-a8e6-025b1a2c091e` (the CEO's — this is the bug).

- [ ] **Step 3: Draft and present the UPDATE statement**

```sql
UPDATE contact_calendars
   SET contact_id = '<curia_agent_contact_id_from_step_1>',
       updated_at = now()
 WHERE nylas_calendar_id = 'nathancuria1@gmail.com';
```

**Do not execute this without presenting it to the user for review first.**

- [ ] **Step 4: Execute the fix after user approval**

Run the UPDATE. Then verify:

```sql
SELECT nylas_calendar_id, contact_id, label, is_primary
  FROM contact_calendars;
```

Expected: `nathancuria1@gmail.com` now has Curia's contact ID. `joseph@josephfung.ca` still has the CEO's contact ID (`6b9c41c5`).

- [ ] **Step 5: Verify via the skill**

Trigger a `calendar-list-calendars` call (e.g., ask Curia "what calendars do you see?" via the web UI) and confirm:
- `nathancuria1@gmail.com` shows `contactName` as Curia (not Joseph Fung)
- `joseph@josephfung.ca` still shows `contactName` as Joseph Fung

---

### Task 6: CHANGELOG and Version Bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version bump)

- [ ] **Step 1: Add changelog entries**

Add under `## [Unreleased]`:

```markdown
### Fixed
- **Calendar ownership** — `calendar-register` no longer defaults `contact_id` to the caller; it is now required, preventing silent mis-assignment of calendar ownership
- **Calendar disambiguation** — coordinator prompt now includes calendar disambiguation rules (parallel to inbox disambiguation) and a calendar exception in the Account Identity section, ensuring events are created on the CEO's calendar by default
- **Calendar smoke test** — added CEO-calendar expectation to `calendar-create-event` smoke test
```

- [ ] **Step 2: Bump version (patch)**

This is a bug fix. Bump the patch version in `package.json`. Check the current version first and increment the patch number.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add CHANGELOG.md package.json
git -C /path/to/worktree commit -m "chore: changelog and version bump for calendar ownership fix"
```
