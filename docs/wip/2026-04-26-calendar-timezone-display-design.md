# Calendar Timezone Display Conversion

**Date:** 2026-04-26
**Issue:** #362
**Branch:** fix/calendar-timezone-display

## Problem

Calendar skill handlers return UTC Z-suffix timestamps (e.g. `"2026-04-06T15:30:00.000Z"`) to the LLM and trust it to convert them to the user's local timezone for display. The LLM does not reliably perform this conversion — it reads the wall-clock digits directly from the ISO string, causing every event to display shifted by the UTC offset (4 hours ahead in EDT).

An 8:00 AM EDT meeting shows as 12:00 PM. For an executive assistant, incorrect calendar times are a critical trust failure.

## Root Cause

The `toIso()` helper in `calendar-list-events/handler.ts` (line 139) calls `new Date(unix * 1000).toISOString()`, which always produces UTC Z-suffix strings. The same pattern exists in `calendar-find-free-time` and `calendar-check-conflicts`. The comment at handler.ts:126-128 assumes the LLM can handle conversion — it cannot.

The infrastructure to fix this mostly exists: the `ExecutionLayer` already carries `this.timezone` from `config.timezone`, and luxon is already a dependency used for DST-safe conversions on the input side (`normalizeTimestamp()`). But there is no output-side conversion utility, and `SkillContext` does not expose the timezone to handlers.

## Design

### 1. `toLocalIso()` utility

Add to `src/time/timestamp.ts` alongside the existing `normalizeTimestamp()`:

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
 */
export function toLocalIso(unixSeconds: number, timezone: string): string
```

Implementation:
- `DateTime.fromSeconds(unixSeconds, { zone: timezone })`
- Validate the resulting DateTime (throw on invalid timezone, same pattern as `formatTimeContextBlock`)
- Return `dt.toISO()` which includes the local offset (e.g. `-04:00`)

### 2. `formatDisplayTimezone()` utility

Add to `src/time/timestamp.ts`:

```typescript
/**
 * Format a timezone label for inclusion in skill result data.
 * Example: formatDisplayTimezone('America/Toronto') → "EDT (UTC-04:00)"
 */
export function formatDisplayTimezone(timezone: string): string
```

Uses the same abbreviation + offset logic as `formatTimeContextBlock` in `time-context.ts`. Skills include this in their result data so the LLM can state which timezone times are displayed in.

### 3. `timezone` on `SkillContext`

Add an optional field to the `SkillContext` interface in `src/skills/types.ts`:

```typescript
/** IANA timezone name (e.g. "America/Toronto") for formatting user-facing timestamps.
 *  Populated from the global config timezone. Skills returning timestamps for display
 *  should use toLocalIso() with this value rather than returning raw UTC strings. */
timezone?: string;
```

Wire in `ExecutionLayer`: when building the SkillContext for each invocation, set `ctx.timezone = this.timezone`. The ExecutionLayer already has `this.timezone` from config — this just exposes it to handlers.

This is an additive change to a public API surface (SkillContext). Non-breaking — existing skills that don't use it are unaffected.

### 4. Handler updates

#### calendar-list-events/handler.ts

Replace the `toIso()` helper:

```typescript
// Before:
const toIso = (unix: number | null, field: string, eventId: string): string | null => {
  if (unix === null) return null;
  if (!Number.isFinite(unix) || unix <= 0) { /* warn and return null */ }
  return new Date(unix * 1000).toISOString();
};

// After:
const tz = ctx.timezone;
const toIso = (unix: number | null, field: string, eventId: string): string | null => {
  if (unix === null) return null;
  if (!Number.isFinite(unix) || unix <= 0) { /* warn and return null — unchanged */ }
  return tz ? toLocalIso(unix, tz) : new Date(unix * 1000).toISOString();
};
```

Add `displayTimezone` to the result data:

```typescript
const data: Record<string, unknown> = {
  events: formattedEvents,
  count: formattedEvents.length,
  displayTimezone: ctx.timezone ? formatDisplayTimezone(ctx.timezone) : null,
};
```

Update the comment block (lines 123-128) to reflect the new approach.

#### calendar-find-free-time/handler.ts

Same pattern — convert the free window timestamps:

```typescript
const tz = ctx.timezone;
const freeWindowsFormatted = filtered.map((w) => ({
  start: tz ? toLocalIso(w.start, tz) : new Date(w.start * 1000).toISOString(),
  end: tz ? toLocalIso(w.end, tz) : new Date(w.end * 1000).toISOString(),
}));
```

Add `displayTimezone` to result data.

#### calendar-check-conflicts/handler.ts

Same pattern — convert conflict timestamps:

```typescript
const tz = ctx.timezone;
// In the conflict push:
startTime: tz ? toLocalIso(slot.startTime, tz) : new Date(slot.startTime * 1000).toISOString(),
endTime: tz ? toLocalIso(slot.endTime, tz) : new Date(slot.endTime * 1000).toISOString(),
```

Add `displayTimezone` to result data.

### 5. Tests

#### New: `toLocalIso()` unit tests

- Basic conversion: `toLocalIso(1775489400, 'America/Toronto')` → `"2026-04-06T11:30:00.000-04:00"`
- DST boundary: verify correct offset during EST vs EDT
- UTC passthrough: `toLocalIso(1775489400, 'UTC')` → `"2026-04-06T15:30:00.000+00:00"` (luxon uses `+00:00`, not `Z`)
- Invalid timezone: throws

#### New: `formatDisplayTimezone()` unit tests

- `formatDisplayTimezone('America/Toronto')` → contains "EDT" and "UTC-04:00" (during EDT)
- `formatDisplayTimezone('UTC')` → contains "UTC"

#### Updated: `calendar-list-events.test.ts`

- The test at line 221 ("formats timed event timestamps as UTC ISO strings") currently expects `"2026-04-06T15:30:00.000Z"`. Update to pass `timezone` in the mock context and expect the local-offset string.
- Add a test verifying fallback to UTC when timezone is not provided.
- Add a test verifying `displayTimezone` is present in result data.

#### Updated: `calendar-find-free-time.test.ts` and `calendar-check-conflicts.test.ts`

- Add timezone-aware assertions for output timestamps.

### 6. Documentation

Add a note to the "Adding a New Skill" section in `CLAUDE.md`:

> **Timestamps:** When a skill returns timestamps for user-facing display, use `toLocalIso()` from `src/time/timestamp.ts` to convert to the user's local timezone (available as `ctx.timezone`). Never return raw UTC Z-suffix strings for times the user will see — LLMs cannot reliably perform timezone conversion. Include `displayTimezone: formatDisplayTimezone(ctx.timezone)` in the result data so the LLM can label its output.

### 7. Changelog

Entry under `## [Unreleased]` in the **Fixed** section:

> **Calendar timezone display** — calendar skill handlers now return timestamps in the user's local timezone instead of UTC. Previously, event times were returned as UTC Z-suffix strings and the LLM was expected to convert them, which it did unreliably — causing all events to display shifted by the UTC offset. Fixes #362.

## Out of Scope

- **Travel-aware timezone resolution** — using profile travel data to determine effective timezone. Separate feature, separate spec.
- **Per-calendar timezone** — calendars store a timezone field but the user wants all events in their local time. Not relevant here.
- **Out-of-hours sanity checking** — flagging events outside 5 AM–11 PM. Separate enhancement.
- **Coordinator prompt changes** — the code fix makes prompt-based conversion unnecessary.
