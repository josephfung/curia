# Specialist Collaboration + Calendar Holds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ceo-inbox` draft meeting-availability replies that are conflict-free, tentatively held (so a slot is never re-offered), and timezone-labelled — by collaborating with the calendar specialist over the existing async bullpen, with the calendar specialist owning tentative "holds."

**Architecture:** Three layers building on each other. (L2) The calendar specialist gains hold ownership: a new `calendar-create-hold` skill, `metadata`/`status` plumbed through the Nylas client, a free/busy fix so `free`-status events no longer block, self-release of holds when a real event books, and a recurring expiry sweep — all behind a `config-store` toggle. **No new database table:** the hold *is* a tagged Nylas event and its metadata *is* the ledger. (L1) A reusable "bullpen consult-and-resume" convention: tap a specialist, park the originating work, resume on reply. No new bullpen primitive. (L3) `ceo-inbox` is rewired from "draft blind + disclaimer" to "consult calendar, park, then draft with the held, timezone-labelled slots."

**Tech Stack:** TypeScript (ESM, Node 24+), Vitest (unit + real-Postgres integration), Nylas calendar API via the normalized `NylasCalendarClient`, KG-backed `ConfigStore`, the YAML-declared scheduler, agent/skill config in `agents/*.yaml` and `skills/*/skill.json`.

**Design spec:** [`docs/wip/2026-06-23-specialist-collaboration-calendar-holds-design.md`](2026-06-23-specialist-collaboration-calendar-holds-design.md) (approved architecture). **Issue:** #1137.

## Global Constraints

- **ESM only.** `.js` extension on every relative import. `import.meta.dirname`, never `__dirname`.
- **No `any`.** Use proper types / discriminated unions. Narrow `Record<string, unknown>` through `unknown` first when casting to a typed interface.
- **Skills never throw.** Return `{ success: true, data }` or `{ success: false, error }`. No empty `catch {}` — every catch logs + handles.
- **Strict-null array access** (`arr[0]` is `T | undefined`): use `arr[0]!` only when guaranteed, else guard.
- **Logging:** pino via `ctx.log`. No `console.log`.
- **Timestamps for display:** convert with `toLocalIso(unixSeconds, ctx.timezone)` and include `displayTimezone: formatDisplayTimezone(ctx.timezone, new Date())`. The LLM must never do timezone math.
- **action_risk is required** in every new `skill.json`. New skills start at `version: "0.1.0"`.
- **No new DB table for holds** (acceptance criterion). The Nylas event metadata is the only ledger.
- **Typecheck via** `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-holds run typecheck` (never bare `tsc`). Run before every commit touching `.ts`.
- **Tests via** `pnpm -C <worktree> test <path>`. Integration tests need the local throwaway Postgres (`curia-test-pg`, port 5433) — see `tests/integration/`.
- **Every PR updates `CHANGELOG.md`** under `## [Unreleased]` and includes `Closes #1137` (or the layer's sub-issue) in the body.
- **Versioning:** bump `version` in each touched `skill.json` / agent YAML (minor for new field/capability, patch for prompt clarification).
- **No em dashes in any user-facing copy** that could reach the CEO (draft bodies, consult replies). Hyphens in identifiers are fine.

---

## File Structure

**New files:**
- `src/channels/calendar/holds.ts` — shared hold helpers: `CURIA_HOLD_KEY`, `buildHoldMetadata()`, `isHoldEvent()`, `eventsOverlap()`, `isHoldStale()`. One responsibility: the hold tagging/overlap/staleness predicates, reused by create-hold, create-event self-release, and the sweep. Keeps hold logic in the calendar domain and DRY.
- `skills/calendar-create-hold/{skill.json,handler.ts,handler.test.ts}` — places a tentative hold.
- `skills/calendar-holds-sweep/{skill.json,handler.ts,handler.test.ts}` — expiry sweep (lists tagged events, deletes stale ones).
- `docs/adr/NNNN-calendar-is-the-ledger-and-bullpen-consult-resume.md` — ADR for the two load-bearing decisions (calendar-as-ledger; consult-and-resume convention).

**Modified files:**
- `src/channels/calendar/nylas-calendar-client.ts` — add `metadata`/`status`/`busy` to `CreateEventInput`; add `metadata` to normalized `NylasCalendarEvent`; pass them through `createEvent`/`updateEvent`; copy `metadata` in `normalizeEvent`.
- `skills/calendar-find-free-time/{skill.json,handler.ts,handler.test.ts}` — `free`-status events no longer block.
- `skills/calendar-check-conflicts/{skill.json,handler.ts,handler.test.ts}` — `free`-status events are not conflicts.
- `skills/calendar-create-event/{handler.ts,handler.test.ts,skill.json}` — self-release of overlapping holds after a real booking.
- `agents/calendar.yaml` — pin `calendar-create-hold` + `calendar-holds-sweep`; prompt: answer a scheduling consult (busy-filtered free time, place holds if enabled, timezone-labelled reply, fallbacks); toggle on/off; daily sweep `schedule` block.
- `agents/ceo-inbox.yaml` — replace scheduling rules with consult-and-resume; park = label + mark-read; resume path; fallbacks.
- `docs/adr/README.md` — add the ADR row.
- `CHANGELOG.md` — `Added`/`Changed` per layer.

**Sequencing (from the design):** Layer 2 read-primitives first (Tasks 1-3), then the hold skills/self-release/sweep (Tasks 4-7), then the calendar prompt (Task 8), then Layer 1+3 ceo-inbox rewire (Tasks 9-10), then ADR/docs (Task 11). Tasks 1-8 = the calendar PR; Tasks 9-10 = the ceo-inbox PR (depends on 8). Task 11 ships with whichever PR introduces the decision.

---

## Task 1: Plumb `metadata` / `status` / `busy` through the Nylas client

**Files:**
- Modify: `src/channels/calendar/nylas-calendar-client.ts` (`NylasCalendarEvent` ~130-144, `CreateEventInput` ~155-163, `createEvent` ~243-279, `updateEvent` ~281-318, `normalizeEvent` ~405-426)
- Test: `src/channels/calendar/nylas-calendar-client.test.ts` (create if absent; otherwise add cases)

**Interfaces:**
- Produces: `NylasCalendarEvent.metadata: Record<string, string> | null`; `CreateEventInput.metadata?: Record<string, string>`, `CreateEventInput.status?: string`, `CreateEventInput.busy?: boolean`. `createEvent`/`updateEvent` forward all three to the raw Nylas request body. Consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Write the failing test.** In `nylas-calendar-client.test.ts`, construct a client with a stubbed `nylas.events.create`/`.list` (mirror the SDK shape: `{ data: rawEvent }` / `{ data: [rawEvent] }`). Assert:
  - `createEvent` passes `metadata`, `status`, and `busy` into the request body when provided.
  - `normalizeEvent` surfaces `metadata` (raw `{ "curia-hold": "true" }` round-trips to `event.metadata`).
  - `metadata` defaults to `null` when the raw event omits it.

```typescript
it('passes metadata/status/busy to the Nylas create request and surfaces metadata on read', async () => {
  const create = vi.fn().mockResolvedValue({ data: { id: 'evt_1', metadata: { 'curia-hold': 'true' }, busy: true, status: 'tentative', when: { startTime: 1000, endTime: 2000 } } });
  const client = makeClientWith({ events: { create } });
  const out = await client.createEvent('cal_1', {
    title: 'HOLD (TBC): coffee', start: '2026-06-25T14:30:00Z', end: '2026-06-25T15:00:00Z',
    busy: true, status: 'tentative', metadata: { 'curia-hold': 'true', 'created-at': '2026-06-24T00:00:00Z' },
  });
  const body = create.mock.calls[0]![0].requestBody;
  expect(body.metadata).toEqual({ 'curia-hold': 'true', 'created-at': '2026-06-24T00:00:00Z' });
  expect(body.status).toBe('tentative');
  expect(body.busy).toBe(true);
  expect(out.metadata).toEqual({ 'curia-hold': 'true' });
});
```

- [ ] **Step 2: Run it; verify it fails** (`metadata` not on type / not passed). `pnpm -C <worktree> test src/channels/calendar/nylas-calendar-client.test.ts`.
- [ ] **Step 3: Implement.**
  - `NylasCalendarEvent`: add `metadata: Record<string, string> | null;`.
  - `CreateEventInput`: add `metadata?: Record<string, string>; status?: string; busy?: boolean;`.
  - `createEvent` request body: conditionally add `...(event.metadata ? { metadata: event.metadata } : {})`, `...(event.status ? { status: event.status } : {})`, `...(typeof event.busy === 'boolean' ? { busy: event.busy } : {})`. (Nylas v3 accepts `metadata`, `status`, `busy` as top-level event fields; values in `metadata` must be strings.)
  - `updateEvent`: same passthrough for the partial-changes body.
  - `normalizeEvent`: add `metadata: evt.metadata ?? null,`.
- [ ] **Step 4: Run; verify pass.** Then `pnpm -C <worktree> run typecheck`.
- [ ] **Step 5: Commit.** `feat(calendar): plumb event metadata/status/busy through Nylas client (#1137)`

---

## Task 2: `calendar-find-free-time` — free-status events no longer block

**Files:**
- Modify: `skills/calendar-find-free-time/handler.ts` (~42-60), `skills/calendar-find-free-time/skill.json` (version + description)
- Test: `skills/calendar-find-free-time/handler.test.ts`

**Interfaces:** No new input (the `onlyBusy` toggle was dropped during review — it overcomplicated the surface). Unconditional behaviour change: a free/busy slot blocks the window unless its `status === 'free'`. So `busy`, `tentative`, and any other non-`free` status all block (this is what makes our `busy: true` holds reduce free windows regardless of how Nylas tags a tentative event); only explicitly `free` slots stop blocking. Fixes the prior bug where every slot blocked.

- [ ] **Step 1: Write the failing test.** Mock `nylasCalendarClient.getFreeBusy` to return one `free` slot and one `busy` slot inside the window. Assert: the free slot does NOT carve out the window (10:00-10:30 stays available); the busy slot does (11:00-11:30 excluded).

```typescript
it('does not let free-status slots block availability; non-free slots still block', async () => {
  const getFreeBusy = vi.fn().mockResolvedValue([{ email: 'cal_1', timeSlots: [
    { startTime: t('10:00'), endTime: t('10:30'), status: 'free' },
    { startTime: t('11:00'), endTime: t('11:30'), status: 'busy' },
  ] }]);
  const res = await run({ input: { calendarIds: ['cal_1'], timeMin: iso('09:00'), timeMax: iso('12:00') }, getFreeBusy });
  expect(freeCovers(res, '10:00', '10:30')).toBe(true);   // free → not blocked
  expect(freeCovers(res, '11:00', '11:30')).toBe(false);  // busy → blocked
});
```

- [ ] **Step 2: Run; verify it fails.**
- [ ] **Step 3: Implement.** In the slot-collection loop, before pushing to `allBusy`:

```typescript
// A free/busy slot blocks the window unless it is explicitly `free`. Tentative
// holds (busy=true, status=tentative) and any non-free status still block,
// which prevents re-offering a held slot. Only `free` is non-blocking (overlap
// with free events is allowed). See #1137.
if (slot.status === 'free') continue;
```

Update `skill.json` description to note free events do not block; bump `version` `1.0.0` → `1.1.0`.
- [ ] **Step 4: Run; verify pass.** Typecheck.
- [ ] **Step 5: Commit.** `feat(calendar): free-status events no longer block free-time search (#1137)`

---

## Task 3: `calendar-check-conflicts` — free-status events are not conflicts

**Files:**
- Modify: `skills/calendar-check-conflicts/handler.ts` (~59-69), `skills/calendar-check-conflicts/skill.json` (version + description)
- Test: `skills/calendar-check-conflicts/handler.test.ts`

**Interfaces:** No new input. Unconditional behaviour change: an overlapping free/busy slot is reported as a conflict only when its `status !== 'free'`. Same semantics as Task 2.

- [ ] **Step 1: Write the failing test.** Mock `getFreeBusy` to overlap the proposed slot with one `free` and one `busy` entry. Assert: only the `busy` slot is reported as a conflict and `clear: false`; a proposed window overlapping only a `free` slot returns `clear: true` with no conflicts.
- [ ] **Step 2: Run; verify it fails.**
- [ ] **Step 3: Implement.** Inside the per-slot loop, before the overlap check:

```typescript
if (slot.status === 'free') continue; // free events do not conflict; non-free (busy/tentative) do. See #1137.
```

Update `skill.json` description; bump `version` `1.0.0` → `1.1.0`.
- [ ] **Step 4: Run; verify pass.** Typecheck.
- [ ] **Step 5: Commit.** `feat(calendar): free-status events are not conflicts in check-conflicts (#1137)`

---

## Task 4: Shared hold helpers + `calendar-create-hold` skill

**Files:**
- Create: `src/channels/calendar/holds.ts`, `skills/calendar-create-hold/skill.json`, `skills/calendar-create-hold/handler.ts`, `skills/calendar-create-hold/handler.test.ts`
- Test: `src/channels/calendar/holds.test.ts`

**Interfaces:**
- `holds.ts` produces:
  - `export const CURIA_HOLD_KEY = 'curia-hold';`
  - `export function buildHoldMetadata(opts: { sourceRef?: string; createdAtIso: string }): Record<string, string>` → `{ 'curia-hold': 'true', 'created-at': createdAtIso, ...(sourceRef ? { 'source-ref': sourceRef } : {}) }`.
  - `export function isHoldEvent(e: { metadata?: Record<string, string> | null }): boolean` → `e.metadata?.[CURIA_HOLD_KEY] === 'true'`.
  - `export function eventsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean` → `aStart < bEnd && aEnd > bStart`.
  - `export function isHoldStale(e, nowUnix, maxAgeMs): boolean` → slot end in the past OR `created-at` older than `maxAgeMs`.
- `calendar-create-hold` produces a skill returning `{ holdEventId: string | null, display: string, held: boolean, reason?: string }`.

**Toggle:** read via `new ConfigStore(ctx.entityMemory, ctx.log).get('calendar_holds', 'enabled')`. Default ON: treat `null` (never set) and `'true'` as enabled; only `'false'` disables. Requires `"entityMemory"` in `capabilities`.

- [ ] **Step 1: Write failing helper tests** in `holds.test.ts` (`buildHoldMetadata` shape; `isHoldEvent` true/false; `eventsOverlap` boundary cases — touching edges do NOT overlap; `isHoldStale` past-slot and age-cap).
- [ ] **Step 2: Run; verify fail.**
- [ ] **Step 3: Implement `holds.ts`.** Pure functions, no I/O. Comment each predicate's intent.
- [ ] **Step 4: Run helper tests; verify pass.**
- [ ] **Step 5: Write failing handler tests** in `skills/calendar-create-hold/handler.test.ts`:
  - Toggle ON (entityMemory returns `null` or `'true'`): calls `nylasCalendarClient.createEvent` with `busy: true`, `status: 'tentative'`, title prefixed `HOLD (TBC):`, no attendees, `metadata['curia-hold']==='true'`; returns `held: true`, a non-null `holdEventId`, and a timezone-labelled `display`.
  - Toggle OFF (`'false'`): does NOT call `createEvent`; returns `held: false`, `holdEventId: null`, `reason: 'holds disabled'`.
  - createEvent throws: returns `{ success: true, data: { held: false, holdEventId: null, reason: ... } }` (a hold failure must never break the caller's draft — design "Failure handling").
- [ ] **Step 6: Run; verify fail.**
- [ ] **Step 7: Implement `skill.json`:**

```json
{
  "name": "calendar-create-hold",
  "description": "Place a tentative HOLD (TBC) on a calendar slot while an offer is outstanding, so the same time is not re-offered to another contact. The hold is a busy/tentative Nylas event with no attendees (no invitations sent), tagged with curia-hold metadata; it auto-releases when a real event books over it and expires via the holds sweep. Honours the calendar_holds toggle (default on) — returns held:false when disabled. Returns a timezone-labelled display string for the slot.",
  "version": "0.1.0",
  "sensitivity": "normal",
  "action_risk": "medium",
  "inputs": {
    "calendarId": "string (Nylas calendar ID to place the hold on)",
    "start": "timestamp (hold start)",
    "end": "timestamp (hold end)",
    "subject": "string? (the meeting subject, used in the hold title and for human readability)",
    "sourceRef": "string? (originating message id / task ref, stored in metadata for traceability)"
  },
  "outputs": {
    "holdEventId": "string|null (Nylas event id of the placed hold, or null when not held)",
    "held": "boolean (true if a hold was placed)",
    "display": "string (timezone-labelled slot, e.g. 'Thursday June 25 at 10:30 AM EDT')",
    "reason": "string? (why no hold was placed: 'holds disabled' or an error summary)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 20000,
  "capabilities": ["nylasCalendarClient", "entityMemory"]
}
```

  `action_risk: "medium"` (min score 70) — lower than `calendar-create-event` (high/80) because a hold has no invitees, sends no notifications, is reversible, and auto-expires (design §Layer 2 + §Autonomy).
- [ ] **Step 8: Implement `handler.ts`.** Validate inputs (calendarId, valid start/end, end>start) → return `{ success:false, error }`. Read toggle; if `'false'` return `{ success:true, data:{ held:false, holdEventId:null, display: <labelled slot>, reason:'holds disabled' } }`. Else build `metadata = buildHoldMetadata({ sourceRef, createdAtIso: new Date().toISOString() })`, call `createEvent(calendarId, { title: 'HOLD (TBC): ' + (subject ?? 'tentative'), start, end, busy: true, status: 'tentative', metadata })` inside try/catch. On success return `held:true`, `holdEventId`, `display: toLocalIso(...)`-derived label + `displayTimezone`. On createEvent error: log, return `held:false`, `reason`. Never throw.
- [ ] **Step 9: Run handler tests; verify pass.** Typecheck.
- [ ] **Step 10: Commit.** `feat(calendar): add calendar-create-hold skill + shared hold helpers (#1137)`

---

## Task 5: Self-release holds when a real event books

**Files:**
- Modify: `skills/calendar-create-event/handler.ts` (after the successful `createEvent` call ~70-80)
- Test: `skills/calendar-create-event/handler.test.ts`

**Interfaces:** Consumes `isHoldEvent`, `eventsOverlap` from `holds.ts`. After a *real* booking (this path only — `calendar-create-hold` is a separate skill and never triggers self-release), list events overlapping the new slot on the same calendar, delete those that are curia-holds.

- [ ] **Step 1: Write the failing test.** Mock `createEvent` to return the new event; mock `listEvents` to return `[ aHold (overlapping, curia-hold), aRealMeeting (overlapping, no metadata), theNewEvent ]`; mock `deleteEvent`. Assert `deleteEvent` is called exactly once, with the hold's id and `notifyAttendees: false`; the real meeting and the new event are NOT deleted. Add a second test: `listEvents` throws → booking still returns `success: true` (self-release failure must not fail the booking).
- [ ] **Step 2: Run; verify fail.**
- [ ] **Step 3: Implement.** After the booking succeeds, in a self-contained try/catch:

```typescript
// Self-release: a real booking supersedes any tentative holds we placed on the
// same slot. List overlapping events and delete only our own curia-hold events.
// Failure here must never fail the booking — the event is already created.
try {
  const startUnix = Math.floor(new Date(start).getTime() / 1000);
  const endUnix = Math.floor(new Date(end).getTime() / 1000);
  const overlapping = await ctx.nylasCalendarClient.listEvents(calendarId, start, end);
  for (const e of overlapping) {
    if (e.id === created.id) continue;
    if (!isHoldEvent(e)) continue;
    if (e.startTime === null || e.endTime === null) continue;
    if (!eventsOverlap(startUnix, endUnix, e.startTime, e.endTime)) continue;
    await ctx.nylasCalendarClient.deleteEvent(calendarId, e.id, false); // no cancellation emails — holds have no attendees
    ctx.log.info({ releasedHoldId: e.id, bookedEventId: created.id }, 'calendar-create-event: released overlapping hold');
  }
} catch (err) {
  ctx.log.warn({ err, bookedEventId: created.id }, 'calendar-create-event: hold self-release failed (booking unaffected)');
}
```

(`calendar-create-event` already declares `nylasCalendarClient`; `deleteEvent(calendarId, eventId, notifyAttendees)` exists. No `skill.json` change unless version bump — bump patch.)
- [ ] **Step 4: Run; verify pass.** Typecheck.
- [ ] **Step 5: Commit.** `feat(calendar): self-release overlapping holds on real booking (#1137)`

---

## Task 6: `calendar-holds-sweep` expiry skill

**Files:**
- Create: `skills/calendar-holds-sweep/skill.json`, `skills/calendar-holds-sweep/handler.ts`, `skills/calendar-holds-sweep/handler.test.ts`

**Interfaces:** Consumes `isHoldEvent`, `isHoldStale` from `holds.ts`. Input `contactId` (passed `${principal_contact_id}` from the schedule), optional `maxAgeDays` (default 7). Resolves the contact's calendars via `ctx.contactService.getCalendarsForContact(contactId)`, lists curia-hold events over the next ~14 days per calendar, deletes those that are stale (slot past OR `created-at` older than maxAge). Returns `{ scanned, expired }`.

- [ ] **Step 1: Write failing handler tests.** Mock `contactService.getCalendarsForContact` → one calendar id; `listEvents` → `[ pastHold(curia-hold, slot ended), freshHold(curia-hold, future, created today), oldHold(curia-hold, created 8d ago), realMeeting(no metadata, past) ]`; `deleteEvent`. Assert: `deleteEvent` called for `pastHold` and `oldHold` only (not `freshHold`, not `realMeeting`); `expired === 2`. Pass a fixed "now" via input or a seam so the test is deterministic (do NOT call `Date.now()` in a way the test can't control — accept an optional `nowMs` input used only in tests, default `Date.now()`).
- [ ] **Step 2: Run; verify fail.**
- [ ] **Step 3: Implement `skill.json`:**

```json
{
  "name": "calendar-holds-sweep",
  "description": "Recurring maintenance: delete tentative calendar holds (curia-hold metadata) whose slot is already in the past or whose created-at exceeds the max hold age (default 7 days). Operates only on Curia-created holds with no attendees; sends no notifications. Intended to be run on a schedule by the calendar specialist.",
  "version": "0.1.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "contactId": "string (whose calendars to sweep — pass ${principal_contact_id})",
    "maxAgeDays": "number? (default 7 — holds older than this by created-at are expired)"
  },
  "outputs": {
    "scanned": "number (curia-hold events examined)",
    "expired": "number (holds deleted)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000,
  "capabilities": ["nylasCalendarClient", "contactService"]
}
```

  `action_risk: "low"`: the sweep only deletes Curia's own tentative holds (curia-hold metadata, no attendees, no notifications) — internal-state cleanup, not a user-facing calendar commitment. Setting this to `high` would let a dipped autonomy score silently stall hold cleanup. **(Decision — flag for reviewer: `low` vs `medium`.)**
- [ ] **Step 4: Implement `handler.ts`.** Validate `contactId`. Resolve calendars; if none, return `{ success:true, data:{ scanned:0, expired:0 } }`. For each calendar, `listEvents(calId, nowIso, nowPlus14dIso)`; filter `isHoldEvent`; for each stale (`isHoldStale(e, nowUnix, maxAgeDays*86400_000)`), `deleteEvent(calId, e.id, false)` in a per-event try/catch (one failure doesn't abort the sweep — log + continue). Return counts. Never throw.
- [ ] **Step 5: Run; verify pass.** Typecheck.
- [ ] **Step 6: Commit.** `feat(calendar): add calendar-holds-sweep expiry skill (#1137)`

---

## Task 7: Wire the sweep into the calendar agent's schedule

**Files:**
- Modify: `agents/calendar.yaml` (`pinned_skills`: add `calendar-create-hold`, `calendar-holds-sweep`; add a `schedule:` block; bump `version`)

**Interfaces:** A declarative cron job that wakes the `calendar` agent daily; the agent runs `calendar-holds-sweep` with `contactId: ${principal_contact_id}`. (Scheduler fires an `agent.task`, not a skill directly, so the agent mediates — confirmed in research.)

- [ ] **Step 1: Add to `pinned_skills`:** `- calendar-create-hold`, `- calendar-holds-sweep`.
- [ ] **Step 2: Add the schedule block:**

```yaml
schedule:
  - cron: "0 1 * * *"   # daily 01:00 local — expire stale tentative holds
    task: >
      Run the calendar holds expiry sweep. Call calendar-holds-sweep with
      contactId set to ${principal_contact_id}. Report the scanned/expired
      counts and exit. Do not perform any other scheduling work on this wake.
```

- [ ] **Step 3: Bump `agents/calendar.yaml` `version`** `0.1.0` → `0.2.0` (new capability).
- [ ] **Step 4: Verify the agent config loads.** Run the agent-config load test if one exists (`pnpm -C <worktree> test agents` / `tests/**/agent*`), else `pnpm -C <worktree> run typecheck` and a boot smoke if available. Confirm the declarative job would be picked up (`loadDeclarativeJobs`).
- [ ] **Step 5: Commit.** `feat(calendar): schedule daily holds expiry sweep + pin hold skills (#1137)`

---

## Task 8: Calendar specialist prompt — answer a scheduling consult; toggle holds

**Files:**
- Modify: `agents/calendar.yaml` system_prompt (Scheduling Intelligence / Conflict sections; add a "Scheduling consult (bullpen)" section and a "Holds toggle" section); bump `version`

**Interfaces:** Defines the **CONSULT REQUEST / CONSULT REPLY** shape (shared verbatim with ceo-inbox in Task 9). The calendar specialist, when woken on a bullpen thread containing a `CONSULT REQUEST`, must:
1. Resolve the CEO's calendar(s) + timezone via `entity-context` on `${principal_contact_id}` (`contact.timezone` column); resolve the contact's timezone via their `entity-context` when known.
2. `memory-query` stored scheduling preferences (existing rule).
3. `calendar-find-free-time` over the requested window (free-status events no longer block), honouring preferences, to get conflict-free windows.
4. Pick N slots (default 2). Read the holds toggle (`config-store` retrieve `namespace: calendar_holds, key: enabled`). If enabled (null/"true"), `calendar-create-hold` for each chosen slot (no_slots/error → handle).
5. `bullpen.reply` with a `CONSULT REPLY` containing timezone-labelled display strings **verbatim from the skills** (CEO tz label always; contact local in parentheses when known) and per-slot "hold placed" status. Fallbacks `no_slots` / `escalate`.

- [ ] **Step 1: Add the consult/reply shape + flow** to the prompt (reproduce the design's CONSULT REQUEST / CONSULT REPLY blocks and the 5 steps above; include the `no_slots` and `escalate` reply variants). Emphasize: never compute timezones yourself — use the skills' `display`/`displayTimezone`.
- [ ] **Step 2: Add the holds toggle section:** "If the CEO says 'stop holding times for me' (or similar), store `calendar_holds.enabled = false` via `config-store`. 'Resume holding times' → store `true`. Before placing holds in a consult, retrieve the toggle; when disabled, propose slots without holds and say so in the reply Notes."
- [ ] **Step 3: Bump `agents/calendar.yaml` `version`** `0.2.0` → `0.3.0`.
- [ ] **Step 4: Review** (no unit test for prompt text). Typecheck (config still loads). Manually re-read for: em-dash-free CEO-facing copy, correct skill names, `${principal_contact_id}` usage.
- [ ] **Step 5: Commit.** `feat(calendar): teach calendar specialist to answer scheduling consults + toggle holds (#1137)`

---

## Task 9: ceo-inbox — consult-and-resume (Layer 1 convention + Layer 3 rewire)

**Files:**
- Modify: `agents/ceo-inbox.yaml` — replace "Scheduling-specific drafting rules" (lines ~460-487); add a "Resume on calendar consult reply" branch to Resume/Bullpen handling; bump `version`

**Interfaces:** Consumes the CONSULT REQUEST/REPLY shape from Task 8. The park marker is `⏳ In Progress` (label, applied via `ceo-inbox-label`) **plus marking the message read** (`ceo-inbox-mark-read`) — read-status is what removes it from the `unread_only: true` triage list; the label is the human-facing "in progress" record and the future stale-sweep anchor. Backstop: `bullpen.post` with `source_message_id` dedups duplicate consults.

- [ ] **Step 1: Delete** the entire "No calendar access" rule (lines ~484-487) and the "pending your calendar" disclaimer. Delete the fixed-window default ("Prefer mid-morning slots (9:30-11:30 AM)") — the calendar specialist now owns slot selection.
- [ ] **Step 2: Replace** the scheduling rules with the consult-and-resume flow. On a `✍️ Drafted` email that is a scheduling request, **do not draft blind**:
  1. **Tap.** `bullpen.post` mentioning `calendar`, content = a `CONSULT REQUEST` (contact display name, subject, duration, stated constraints/date window, `contact_timezone=known|unknown`), `source_message_id: <message_id>` (dedup key).
  2. **Park.** `ceo-inbox-label` apply `⏳ In Progress`; `ceo-inbox-mark-read` the message. **Do NOT archive, do NOT draft yet.** Report classification.
  3. (Triage-skip is automatic: the message is now read, so the next `ceo-inbox-list unread_only:true` run won't return it.)
- [ ] **Step 3: Add the resume branch** to the Resume/bullpen-reply handling: when woken by a bullpen reply on a calendar consult thread (a `CONSULT REPLY`):
  - Read the original message via `ceo-inbox-read` using `source_message_id` (carried in the consult).
  - Draft with `ceo-inbox-draft-reply`, using the calendar's returned display strings **verbatim** (e.g. `Thursday June 25 at 10:30 AM EDT (7:30 AM PDT their time)`). Keep `date-resolve` discipline for any date+day-of-week pair before writing it.
  - **Transition the park marker to the terminal classification.** Call `ceo-inbox-update-folders` with `add_folders: ['✍️ Drafted']` and `remove_folders: ['⏳ In Progress']`. The outcome is a drafted reply the CEO reviews and sends, so `✍️ Drafted` is the correct terminal label (not `✅ Handled`, which signals "delegated and done, no human action needed"). This records the result AND clears the in-progress marker so the message stops showing under `⏳ In Progress`.
  - Then `ceo-inbox-archive` the message (removes from INBOX). (It was already marked read at park time.)
  - **Fallbacks:**
    - `Result: no_slots` → draft using the nearest alternatives the calendar returned, then the same `✍️ Drafted` transition + archive.
    - `Result: escalate` → do **not** draft. Call `ceo-inbox-update-folders` with `remove_folders: ['⏳ In Progress']` (clear the in-progress marker) and route a note to the CEO via the existing coordinator-notify (🚨 Urgent) path explaining why a draft could not be prepared. Do **not** archive — leave it in the inbox for the CEO to handle.
- [ ] **Step 4: Failure handling.** If the consult never returns, the message stays read + `⏳ In Progress` + unarchived — visible under the label, never silently dropped (a stale-`⏳ In Progress` → `⚠️ Stuck` sweep is an explicit follow-up, design open question #1, out of scope here). If `bullpen.post` returns `deduplicated: true`, treat as already-parked and exit without re-labelling churn.
- [ ] **Step 5: Bump `agents/ceo-inbox.yaml` `version`** `0.10.0` → `0.11.0` (new collaboration capability).
- [ ] **Step 6: Review.** Typecheck (config loads). Re-read for em-dash-free draft copy, correct skill names (`bullpen`, `ceo-inbox-label`, `ceo-inbox-mark-read`, `ceo-inbox-read`, `ceo-inbox-draft-reply`, `ceo-inbox-archive`, `date-resolve` — all already pinned), and that no "blind draft" scheduling path remains.
- [ ] **Step 7: Commit.** `feat(ceo-inbox): consult calendar specialist before drafting scheduling replies (#1137)`

---

## Task 10: Integration test — consult-and-resume round trip + hold lifecycle

**Files:**
- Create: `tests/integration/calendar-holds-collaboration.test.ts` (real Postgres; Nylas client mocked at the client seam, bullpen/config-store real against the test DB)

**Interfaces:** Exercises the cross-cutting behaviours the unit tests can't: bullpen dedup + config-store toggle round-trip against a real KG.

- [ ] **Step 1: Write the failing tests.**
  - **Hold placed → released on booking:** create a hold via `calendar-create-hold` (toggle default ON, real config-store), then `calendar-create-event` over the same slot, assert the hold's `deleteEvent` was invoked (mock Nylas records calls; metadata round-trips through create→list).
  - **Toggle off suppresses holds:** `config-store` store `calendar_holds.enabled=false`; `calendar-create-hold` returns `held:false` and does not call `createEvent`.
  - **Bullpen dedup backstop:** two `bullpen.post` with the same `source_message_id` → second returns `deduplicated: true` (no second thread row).
  - **No-table assertion:** assert no migration referencing holds exists (`ls src/db/migrations | grep -i hold` is empty) and metadata round-trips create→list without any new table.
- [ ] **Step 2: Run; verify fail (or skip locally if no Docker — CI is the gate per repo convention).**
- [ ] **Step 3: Make them pass** (wiring fixes only — behaviour already built in Tasks 1-9).
- [ ] **Step 4: Run the full unit suite + typecheck.** `pnpm -C <worktree> test` ; `pnpm -C <worktree> run typecheck`.
- [ ] **Step 5: Commit.** `test: integration coverage for calendar holds + consult-and-resume (#1137)`

---

## Task 11: ADR (consult-and-resume) + CHANGELOG + docs sweep

**Files:**
- Create: `docs/adr/NNNN-bullpen-consult-and-resume.md` (use `docs/adr/template.md`; next number from `docs/adr/README.md`)
- Modify: `docs/adr/README.md` (add row), `CHANGELOG.md` (Added/Changed)
- Check: `skills/setup-status/catalog.yaml` (holds add no new credential → no entry; record that decision in the PR), curia-docs (calendar/scheduling page if user-facing behaviour is described publicly)

- [ ] **Step 1: Write the ADR — bullpen consult-and-resume convention only.** A reusable async pattern (tap a specialist via `bullpen.post` → park the originating work → resume on the `bullpen.reply` wake) for any agent that needs another specialist mid-task. Context: the bullpen is async by design (#721); the only synchronous cross-agent primitive, `delegate`, is coordinator-locked. Decision: adopt the async tap/park/resume convention rather than a synchronous cross-agent RPC or a new event type. Consequences: resume latency is seconds-to-minutes (acceptable — drafts sit for human review anyway); the park marker + `source_message_id` dedup prevent duplicate work; generalizes to tapping multiple specialists. (The calendar-as-ledger storage choice is a tactical decision recorded in the design spec, not an ADR — per review.)
- [ ] **Step 2: Add the ADR row** to `docs/adr/README.md`.
- [ ] **Step 3: CHANGELOG** under `## [Unreleased]`:
  - **Added** — `calendar-create-hold` skill (tentative holds, `curia-hold`-tagged, toggle-gated); `calendar-holds-sweep` daily expiry; bullpen consult-and-resume convention.
  - **Changed** — `calendar-find-free-time` / `calendar-check-conflicts` no longer block on `free`-status events; `calendar-create-event` self-releases overlapping holds; Nylas client surfaces event `metadata`; `ceo-inbox` consults the calendar specialist before drafting scheduling replies instead of drafting blind.
- [ ] **Step 4: Commit.** `docs: ADR + changelog for consult-and-resume convention (#1137)`

---

## Self-Review (run before execution)

**Spec coverage** (each acceptance criterion → task):
1. ceo-inbox taps calendar via bullpen, no blind draft → **Task 9**.
2. Proposed times never overlap `busy`; `free` allowed → **Tasks 2, 3** (`free`-status no longer blocks) + Task 8 (specialist uses find-free-time).
3. AC as written asks for an `onlyBusy` param (default true); per review the param is dropped and the behaviour is made unconditional (free never blocks, every other status does) → **Tasks 2, 3**. Intent met; the explicit param is intentionally not added (update the issue AC text to match).
4. Offered slots tentatively held (`HOLD (TBC)`, busy/tentative, no attendees, `curia-hold`) → **Task 4**.
5. Real booking auto-releases overlapping holds → **Task 5**.
6. Recurring job expires holds (slot past or >max age) → **Tasks 6, 7**.
7. Every proposed time labelled in CEO tz (+ contact local when known) → **Tasks 4, 8** (skills return display strings; specialist labels; ceo-inbox copies verbatim).
8. Holds honour a `config-store` toggle (default ON); "stop holding times" persists `enabled=false` → **Tasks 4, 8**.
9. **No new DB table** → guaranteed (calendar-as-ledger); asserted in **Task 10**.
10. Source email parked `⏳ In Progress`, not archived until draft written → **Task 9** (label + mark-read; archive only on resume).

**Placeholder scan:** none — every code step shows the code or an exact verbatim-edit instruction against quoted current text.

**Type consistency:** `metadata: Record<string,string> | null` (read) vs `Record<string,string>` (write input) is intentional and consistent across Tasks 1/4/5/6. `isHoldEvent`/`eventsOverlap`/`isHoldStale` defined once in `holds.ts` (Task 4), reused in Tasks 5/6 with matching signatures.

**Resolved during review:** `onlyBusy` param dropped — free-events-don't-block is now unconditional in Tasks 2/3; resume transitions `⏳ In Progress` → `✍️ Drafted` (Task 9); single ADR scoped to consult-and-resume (Task 11).

**Open decision flagged for the reviewer:** `calendar-holds-sweep` action_risk `low` vs `medium` (Task 6). Does not block implementation.

---

## Execution Handoff

Tasks 1-8 + 11 form the **calendar PR** (Layer 2). Tasks 9-10 form the **ceo-inbox PR** (Layers 1+3), which depends on Task 8's consult shape. This matches the issue's "Layer 2 read-primitives land first" and keeps each PR independently reviewable.
