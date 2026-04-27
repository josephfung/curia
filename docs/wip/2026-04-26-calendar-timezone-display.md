# Calendar Timezone Display Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix calendar skill handlers to return timestamps in the user's local timezone instead of UTC, so the LLM displays correct wall-clock times.

**Architecture:** Add a `toLocalIso()` output utility (complement to the existing `normalizeTimestamp()` input utility), expose `timezone` on `SkillContext`, and update all three calendar handlers to convert before returning. Defensive fallback to UTC when timezone is unavailable.

**Tech Stack:** TypeScript/ESM, luxon (already a dependency), vitest

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz`
**Branch:** `fix/calendar-timezone-display`
**Design:** `docs/wip/2026-04-26-calendar-timezone-display-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/time/timestamp.ts` | Add `toLocalIso()` and `formatDisplayTimezone()` |
| Modify | `src/skills/types.ts` | Add `timezone?: string` to `SkillContext` |
| Modify | `src/skills/execution.ts` | Wire `this.timezone` into ctx |
| Modify | `skills/calendar-list-events/handler.ts` | Use `toLocalIso()` for output timestamps |
| Modify | `skills/calendar-find-free-time/handler.ts` | Use `toLocalIso()` for output timestamps |
| Modify | `skills/calendar-check-conflicts/handler.ts` | Use `toLocalIso()` for output timestamps |
| Create | `tests/unit/time/timestamp.test.ts` | Tests for `toLocalIso()` and `formatDisplayTimezone()` |
| Modify | `tests/unit/skills/calendar-list-events.test.ts` | Update timestamp expectations, add timezone tests |
| Modify | `tests/unit/skills/calendar-find-free-time.test.ts` | Add timezone-aware assertions |
| Modify | `tests/unit/skills/calendar-check-conflicts.test.ts` | Add timezone-aware assertions |
| Modify | `CLAUDE.md` | Add timestamp guidance to "New Skill" section |
| Modify | `CHANGELOG.md` | Add entry under [Unreleased] > Fixed |

---

## Task 1: Add `toLocalIso()` and `formatDisplayTimezone()` utilities

**Files:**
- Modify: `src/time/timestamp.ts`
- Create: `tests/unit/time/timestamp.test.ts`

- [ ] **Step 1: Write failing tests for `toLocalIso()`**

Create `tests/unit/time/timestamp.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { toLocalIso, formatDisplayTimezone } from '../../../src/time/timestamp.js';

describe('toLocalIso', () => {
  it('converts Unix seconds to local ISO with offset for America/Toronto in EDT', () => {
    // 1775489400 = 2026-04-06T15:30:00Z = 2026-04-06T11:30:00 EDT (UTC-4)
    expect(toLocalIso(1775489400, 'America/Toronto')).toBe('2026-04-06T11:30:00.000-04:00');
  });

  it('converts Unix seconds to local ISO with offset for America/Toronto in EST', () => {
    // 1738350600 = 2025-01-31T18:30:00Z = 2025-01-31T13:30:00 EST (UTC-5)
    expect(toLocalIso(1738350600, 'America/Toronto')).toBe('2025-01-31T13:30:00.000-05:00');
  });

  it('handles UTC timezone', () => {
    // luxon uses +00:00 for UTC, not Z
    expect(toLocalIso(1775489400, 'UTC')).toBe('2026-04-06T15:30:00.000+00:00');
  });

  it('handles non-hour-aligned timezone offsets', () => {
    // Asia/Kolkata is UTC+05:30
    // 1775489400 = 2026-04-06T15:30:00Z = 2026-04-06T21:00:00+05:30
    expect(toLocalIso(1775489400, 'Asia/Kolkata')).toBe('2026-04-06T21:00:00.000+05:30');
  });

  it('throws on invalid timezone', () => {
    expect(() => toLocalIso(1775489400, 'Not/A/Zone')).toThrow('invalid timezone');
  });
});

describe('formatDisplayTimezone', () => {
  it('formats EDT timezone label', () => {
    // April 2026 — EDT is active
    const label = formatDisplayTimezone('America/Toronto', new Date('2026-04-06T15:30:00Z'));
    expect(label).toContain('EDT');
    expect(label).toContain('UTC-04:00');
  });

  it('formats EST timezone label', () => {
    // January 2025 — EST is active
    const label = formatDisplayTimezone('America/Toronto', new Date('2025-01-31T18:30:00Z'));
    expect(label).toContain('EST');
    expect(label).toContain('UTC-05:00');
  });

  it('formats UTC timezone label', () => {
    const label = formatDisplayTimezone('UTC', new Date('2026-04-06T15:30:00Z'));
    expect(label).toContain('UTC');
  });

  it('throws on invalid timezone', () => {
    expect(() => formatDisplayTimezone('Not/A/Zone', new Date())).toThrow('invalid timezone');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test -- tests/unit/time/timestamp.test.ts`

Expected: FAIL — `toLocalIso` and `formatDisplayTimezone` are not exported from `timestamp.ts`.

- [ ] **Step 3: Implement `toLocalIso()` and `formatDisplayTimezone()`**

Add to the end of `src/time/timestamp.ts` (after the existing `normalizeTimestamp` function):

```typescript
/**
 * Convert Unix seconds to an ISO 8601 string in the given IANA timezone,
 * with the local UTC offset baked in.
 *
 * Example: toLocalIso(1775489400, 'America/Toronto') → "2026-04-06T11:30:00.000-04:00"
 *
 * This is the output-side complement to normalizeTimestamp() (which handles inputs).
 * The wall-clock digits in the returned string match the user's local time, so LLMs
 * read them correctly without needing to perform timezone arithmetic.
 *
 * @param unixSeconds  Unix epoch seconds (as returned by Nylas calendar API)
 * @param timezone     IANA timezone name (e.g. "America/Toronto")
 */
export function toLocalIso(unixSeconds: number, timezone: string): string {
  const dt = DateTime.fromSeconds(unixSeconds, { zone: timezone });
  if (!dt.isValid) {
    throw new Error(`toLocalIso: invalid timezone "${timezone}" (${dt.invalidReason ?? 'unknown reason'})`);
  }
  return dt.toISO()!;
}

/**
 * Format a timezone label for inclusion in skill result data, so the LLM can
 * state which timezone event times are displayed in.
 *
 * Example: formatDisplayTimezone('America/Toronto', now) → "EDT (UTC-04:00)"
 *
 * @param timezone  IANA timezone name
 * @param now       Reference date for resolving DST abbreviation and offset
 */
export function formatDisplayTimezone(timezone: string, now: Date): string {
  const dt = DateTime.fromJSDate(now, { zone: timezone });
  if (!dt.isValid) {
    throw new Error(`formatDisplayTimezone: invalid timezone "${timezone}" (${dt.invalidReason ?? 'unknown reason'})`);
  }
  const abbr = dt.toFormat('ZZZZ');
  const sign = dt.offset >= 0 ? '+' : '-';
  const absMin = Math.abs(dt.offset);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  const offsetLabel = dt.offset === 0 ? 'UTC' : `UTC${sign}${hh}:${mm}`;
  // When abbr equals the offset string (some zones lack named abbreviations),
  // just return the offset to avoid redundancy like "UTC+05:30 (UTC+05:30)".
  if (abbr === dt.toFormat('ZZ') || abbr === offsetLabel) {
    return offsetLabel;
  }
  return `${abbr} (${offsetLabel})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test -- tests/unit/time/timestamp.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/time/timestamp.ts tests/unit/time/timestamp.test.ts
git -C /path/to/worktree commit -m "feat: add toLocalIso() and formatDisplayTimezone() utilities (#362)"
```

---

## Task 2: Add `timezone` to `SkillContext` and wire through `ExecutionLayer`

**Files:**
- Modify: `src/skills/types.ts:113` (SkillContext interface)
- Modify: `src/skills/execution.ts:289` (ctx object construction)

- [ ] **Step 1: Add `timezone` to `SkillContext` interface**

In `src/skills/types.ts`, add after the `taskMetadata` field (line 184):

```typescript
  /** IANA timezone name (e.g. "America/Toronto") for formatting user-facing timestamps.
   *  Populated from the global config timezone. Skills returning timestamps for display
   *  should use toLocalIso() with this value rather than returning raw UTC strings. */
  timezone?: string;
```

- [ ] **Step 2: Wire `timezone` into the ctx object in `ExecutionLayer.invoke()`**

In `src/skills/execution.ts`, add `timezone: this.timezone,` to the ctx object construction block. Add it after the `taskMetadata` assignment (line 288), before the closing brace of the ctx object:

```typescript
      taskMetadata: options?.taskMetadata,
      // Expose the configured timezone so skills can format output timestamps
      // in the user's local time. See toLocalIso() in src/time/timestamp.ts.
      timezone: this.timezone,
    };
```

- [ ] **Step 3: Run the full test suite to verify no regressions**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test`

Expected: All existing tests pass. The new field is optional and unused by existing code, so nothing should break.

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add src/skills/types.ts src/skills/execution.ts
git -C /path/to/worktree commit -m "feat: expose timezone on SkillContext for output formatting (#362)"
```

---

## Task 3: Update `calendar-list-events` handler

**Files:**
- Modify: `skills/calendar-list-events/handler.ts`
- Modify: `tests/unit/skills/calendar-list-events.test.ts`

- [ ] **Step 1: Update the test for timestamp formatting to expect local-offset strings**

In `tests/unit/skills/calendar-list-events.test.ts`, replace the test at line 221 ("formats timed event timestamps as UTC ISO strings for LLM consumption"):

```typescript
  it('formats timed event timestamps in the configured timezone', async () => {
    // 1775489400 Unix seconds = 2026-04-06T15:30:00Z = 11:30 AM EDT (UTC-4)
    // 1775491200 Unix seconds = 2026-04-06T16:00:00Z = 12:00 PM EDT (UTC-4)
    const timedEvent = {
      id: 'evt-timed',
      title: 'Catchup',
      description: '',
      participants: [],
      startTime: 1775489400,
      endTime: 1775491200,
      startDate: null,
      endDate: null,
      location: '',
      conferencing: null,
      status: 'confirmed',
      calendarId: 'cal-1',
      busy: true,
    };
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue([timedEvent]),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-06T00:00:00Z', timeMax: '2026-04-07T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never, timezone: 'America/Toronto' },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ startTime: string; endTime: string }>; displayTimezone: string };
      // Wall-clock digits should be in EDT (UTC-4), not UTC
      expect(data.events[0].startTime).toBe('2026-04-06T11:30:00.000-04:00');
      expect(data.events[0].endTime).toBe('2026-04-06T12:00:00.000-04:00');
      expect(data.displayTimezone).toContain('EDT');
    }
  });
```

- [ ] **Step 2: Add a test for UTC fallback when timezone is not provided**

Add after the previous test:

```typescript
  it('falls back to UTC ISO strings when timezone is not provided', async () => {
    const timedEvent = {
      id: 'evt-timed',
      title: 'Catchup',
      description: '',
      participants: [],
      startTime: 1775489400,
      endTime: 1775491200,
      startDate: null,
      endDate: null,
      location: '',
      conferencing: null,
      status: 'confirmed',
      calendarId: 'cal-1',
      busy: true,
    };
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue([timedEvent]),
    };

    // No timezone in context — should fall back to UTC Z-suffix
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-06T00:00:00Z', timeMax: '2026-04-07T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ startTime: string }>; displayTimezone: null };
      expect(data.events[0].startTime).toBe('2026-04-06T15:30:00.000Z');
      expect(data.displayTimezone).toBeNull();
    }
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test -- tests/unit/skills/calendar-list-events.test.ts`

Expected: FAIL — handler still returns UTC Z-suffix and no `displayTimezone`.

- [ ] **Step 4: Update the handler**

In `skills/calendar-list-events/handler.ts`:

Add the import at line 2 (after the existing imports):

```typescript
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
```

Replace the comment block and `toIso` helper (lines 123-140) with:

```typescript
      // Format events for LLM consumption.
      // Nylas returns timed event timestamps as Unix seconds. Convert to the user's
      // local timezone so the wall-clock digits in the ISO string match local time.
      // The LLM reads these digits directly — it cannot reliably do UTC conversion.
      // Falls back to UTC Z-suffix when timezone is not configured (defensive).
      //
      // Guard non-finite and non-positive values: Unix 0 is never a real calendar
      // event time, and passing "1970-01-01T00:00:00Z" to the LLM would be silently
      // wrong. Log and null-out rather than propagate corrupted data.
      const tz = ctx.timezone;
      const toIso = (unix: number | null, field: string, eventId: string): string | null => {
        if (unix === null) return null;
        if (!Number.isFinite(unix) || unix <= 0) {
          ctx.log.warn({ eventId, field, value: unix }, `calendar-list-events: suspicious ${field} value — omitting`);
          return null;
        }
        return tz ? toLocalIso(unix, tz) : new Date(unix * 1000).toISOString();
      };
```

Replace the `data` construction (line 148) with:

```typescript
      const data: Record<string, unknown> = {
        events: formattedEvents,
        count: formattedEvents.length,
        displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
      };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test -- tests/unit/skills/calendar-list-events.test.ts`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add skills/calendar-list-events/handler.ts tests/unit/skills/calendar-list-events.test.ts
git -C /path/to/worktree commit -m "fix: calendar-list-events returns local timezone timestamps (#362)"
```

---

## Task 4: Update `calendar-find-free-time` handler

**Files:**
- Modify: `skills/calendar-find-free-time/handler.ts`
- Modify: `tests/unit/skills/calendar-find-free-time.test.ts`

- [ ] **Step 1: Add timezone-aware test**

Add to the end of the `describe` block in `tests/unit/skills/calendar-find-free-time.test.ts`:

```typescript
  it('formats free window timestamps in the configured timezone', async () => {
    // Use realistic timestamps: busy 9:00-10:00 AM EDT on 2026-04-06
    // 1775480400 = 2026-04-06T13:00:00Z = 9:00 AM EDT
    // 1775484000 = 2026-04-06T14:00:00Z = 10:00 AM EDT
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [{ startTime: 1775480400, endTime: 1775484000, status: 'busy' }],
      }]),
    };

    // Query range: 8:00 AM - 12:00 PM EDT
    // 1775476800 = 2026-04-06T12:00:00Z = 8:00 AM EDT
    // 1775491200 = 2026-04-06T16:00:00Z = 12:00 PM EDT
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '2026-04-06T12:00:00Z', timeMax: '2026-04-06T16:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never, timezone: 'America/Toronto' },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string; end: string }>; displayTimezone: string };
      // Free: 8:00-9:00 AM EDT, 10:00 AM-12:00 PM EDT
      expect(data.freeWindows[0].start).toBe('2026-04-06T08:00:00.000-04:00');
      expect(data.freeWindows[0].end).toBe('2026-04-06T09:00:00.000-04:00');
      expect(data.freeWindows[1].start).toBe('2026-04-06T10:00:00.000-04:00');
      expect(data.freeWindows[1].end).toBe('2026-04-06T12:00:00.000-04:00');
      expect(data.displayTimezone).toContain('EDT');
    }
  });

  it('falls back to UTC when timezone is not provided', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [{ startTime: 1775480400, endTime: 1775484000, status: 'busy' }],
      }]),
    };

    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '2026-04-06T12:00:00Z', timeMax: '2026-04-06T16:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string; end: string }>; displayTimezone: null };
      // UTC Z-suffix when no timezone configured
      expect(data.freeWindows[0].start).toBe('2026-04-06T12:00:00.000Z');
      expect(data.displayTimezone).toBeNull();
    }
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test -- tests/unit/skills/calendar-find-free-time.test.ts`

Expected: New tests FAIL (handler still returns UTC, no `displayTimezone`). Existing tests still pass.

- [ ] **Step 3: Update the handler**

In `skills/calendar-find-free-time/handler.ts`:

Add the import after the existing import (line 6):

```typescript
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
```

Replace lines 84-88 (the comment and `freeWindowsIso` mapping):

```typescript
      // Format timestamps in the user's local timezone so the LLM reads correct
      // wall-clock times. Falls back to UTC Z-suffix when timezone is not configured.
      const tz = ctx.timezone;
      const freeWindowsFormatted = filtered.map((w) => ({
        start: tz ? toLocalIso(w.start, tz) : new Date(w.start * 1000).toISOString(),
        end: tz ? toLocalIso(w.end, tz) : new Date(w.end * 1000).toISOString(),
      }));
```

Update the return statement (line 91) — replace `freeWindowsIso` with `freeWindowsFormatted` and add `displayTimezone`:

```typescript
      ctx.log.info({ calendarCount: calendarIds.length, freeWindowCount: freeWindowsFormatted.length }, 'Found free time');
      return { success: true, data: { freeWindows: freeWindowsFormatted, displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null } };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test -- tests/unit/skills/calendar-find-free-time.test.ts`

Expected: All tests PASS (including the existing ones — they don't pass `timezone`, so they get UTC fallback which matches their current expectations).

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add skills/calendar-find-free-time/handler.ts tests/unit/skills/calendar-find-free-time.test.ts
git -C /path/to/worktree commit -m "fix: calendar-find-free-time returns local timezone timestamps (#362)"
```

---

## Task 5: Update `calendar-check-conflicts` handler

**Files:**
- Modify: `skills/calendar-check-conflicts/handler.ts`
- Modify: `tests/unit/skills/calendar-check-conflicts.test.ts`

- [ ] **Step 1: Add timezone-aware test**

Add to the end of the `describe` block in `tests/unit/skills/calendar-check-conflicts.test.ts`:

```typescript
  it('formats conflict timestamps in the configured timezone', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [
          // Busy: 2026-04-06T13:00:00Z - 14:00:00Z = 9:00-10:00 AM EDT
          { startTime: 1775480400, endTime: 1775484000, status: 'busy' },
        ],
      }]),
    };
    const contactService = {
      resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'c1' }),
      getContact: vi.fn().mockResolvedValue({ id: 'c1', displayName: 'Jane Doe' }),
    };

    // Proposed time overlaps the busy period
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], proposedStart: '2026-04-06T12:30:00Z', proposedEnd: '2026-04-06T13:30:00Z' },
      {
        nylasCalendarClient: nylasCalendarClient as never,
        contactService: contactService as never,
        timezone: 'America/Toronto',
      },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        conflicts: Array<{ startTime: string; endTime: string }>;
        clear: boolean;
        displayTimezone: string;
      };
      expect(data.clear).toBe(false);
      expect(data.conflicts).toHaveLength(1);
      // Timestamps should be in EDT (UTC-4), not UTC
      expect(data.conflicts[0].startTime).toBe('2026-04-06T09:00:00.000-04:00');
      expect(data.conflicts[0].endTime).toBe('2026-04-06T10:00:00.000-04:00');
      expect(data.displayTimezone).toContain('EDT');
    }
  });

  it('falls back to UTC when timezone is not provided', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [
          { startTime: 1775480400, endTime: 1775484000, status: 'busy' },
        ],
      }]),
    };

    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], proposedStart: '2026-04-06T12:30:00Z', proposedEnd: '2026-04-06T13:30:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { conflicts: Array<{ startTime: string }>; displayTimezone: null };
      // UTC Z-suffix when no timezone configured
      expect(data.conflicts[0].startTime).toBe('2026-04-06T13:00:00.000Z');
      expect(data.displayTimezone).toBeNull();
    }
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test -- tests/unit/skills/calendar-check-conflicts.test.ts`

Expected: New tests FAIL. Existing tests still pass.

- [ ] **Step 3: Update the handler**

In `skills/calendar-check-conflicts/handler.ts`:

Add the import after line 6:

```typescript
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
```

Inside the `try` block, add this after the `proposedEndTs` line (line 35):

```typescript
      const tz = ctx.timezone;
```

Replace the comment and timestamp formatting inside the conflict push (lines 59-64):

```typescript
            // Format timestamps in the user's local timezone so the LLM reads correct
            // wall-clock times. Falls back to UTC Z-suffix when timezone is not configured.
            conflicts.push({
              calendarId: result.email,
              contactName,
              startTime: tz ? toLocalIso(slot.startTime, tz) : new Date(slot.startTime * 1000).toISOString(),
              endTime: tz ? toLocalIso(slot.endTime, tz) : new Date(slot.endTime * 1000).toISOString(),
              status: slot.status,
            });
```

Update the return statement (line 73) to include `displayTimezone`:

```typescript
      ctx.log.info({ calendarCount: calendarIds.length, conflictCount: conflicts.length }, 'Checked conflicts');
      return { success: true, data: { conflicts, clear, displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null } };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test -- tests/unit/skills/calendar-check-conflicts.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add skills/calendar-check-conflicts/handler.ts tests/unit/skills/calendar-check-conflicts.test.ts
git -C /path/to/worktree commit -m "fix: calendar-check-conflicts returns local timezone timestamps (#362)"
```

---

## Task 6: Documentation and changelog

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add timestamp guidance to the "New Skill" section in CLAUDE.md**

In `CLAUDE.md`, after line 70 (the end of the "New Skill" subsection, before "### Autonomy Awareness"), add:

```markdown
4. **Timestamps:** When a skill returns timestamps for user-facing display, use `toLocalIso()` from `src/time/timestamp.ts` to convert to the user's local timezone (available as `ctx.timezone`). Never return raw UTC Z-suffix strings for times the user will see — LLMs cannot reliably perform timezone conversion. Include `displayTimezone: formatDisplayTimezone(ctx.timezone)` in the result data so the LLM can label its output.
```

- [ ] **Step 2: Add changelog entry**

In `CHANGELOG.md`, add to the existing `### Fixed` section under `## [Unreleased]` (after line 22):

```markdown
- **Calendar timezone display** — calendar skill handlers (`calendar-list-events`, `calendar-find-free-time`, `calendar-check-conflicts`) now return timestamps in the user's local timezone instead of UTC. Previously, event times were returned as UTC Z-suffix strings and the LLM was expected to convert them, which it did unreliably — causing all events to display shifted by the UTC offset. Added `toLocalIso()` and `formatDisplayTimezone()` utilities, and exposed `timezone` on `SkillContext` (additive, non-breaking public API surface change). Fixes #362
```

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add CLAUDE.md CHANGELOG.md
git -C /path/to/worktree commit -m "docs: add timezone guidance for skills and changelog entry (#362)"
```

---

## Task 7: Full test suite and typecheck

- [ ] **Step 1: Run typecheck**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz run typecheck`

Expected: Clean — no type errors.

- [ ] **Step 2: Run full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-tz test`

Expected: All tests pass with no regressions.

- [ ] **Step 3: Fix any failures and commit**

If any failures, fix and commit with an appropriate message.
