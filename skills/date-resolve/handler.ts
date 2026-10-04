// skills/date-resolve/handler.ts
//
// Deterministic date resolution and verification. LLMs are unreliable at
// day-of-week arithmetic — this skill provides a tool they can call to
// verify date + day-of-week pairings or resolve relative expressions
// ("tomorrow", "next Monday", "this Friday") to absolute dates.
//
// Pure computation using luxon. No external services, no side effects.

import { DateTime } from 'luxon';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { formatDisplayTimezone } from '../../src/time/timestamp.js';
import { RELATIVE_DAY_OFFSETS } from '../../src/time/relative-days.js';

/** Canonical day names for matching against user input. */
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
type DayName = (typeof DAY_NAMES)[number];

/** Map lowercase day name to luxon weekday number (1=Monday … 7=Sunday). */
const DAY_TO_WEEKDAY: Record<string, number> = {};
for (let i = 0; i < DAY_NAMES.length; i++) {
  // i is bounded by DAY_NAMES.length, so the element is always present
  // (noUncheckedIndexedAccess types it as possibly-undefined).
  DAY_TO_WEEKDAY[DAY_NAMES[i]!.toLowerCase()] = i + 1;
}

/**
 * Try to parse a date string in various formats. Returns a valid DateTime or null.
 * Supports:
 *   - ISO: "2026-05-19"
 *   - Natural: "May 19, 2026" / "May 19 2026"
 *   - US-ish: "05/19/2026"
 */
function parseDate(raw: string, timezone: string): DateTime | null {
  const trimmed = raw.trim();

  // ISO date (yyyy-MM-dd)
  const iso = DateTime.fromISO(trimmed, { zone: timezone });
  if (iso.isValid) return iso.startOf('day');

  // "May 19, 2026" or "May 19 2026"
  for (const fmt of ['MMMM d, yyyy', 'MMMM d yyyy', 'MMM d, yyyy', 'MMM d yyyy']) {
    const dt = DateTime.fromFormat(trimmed, fmt, { zone: timezone });
    if (dt.isValid) return dt.startOf('day');
  }

  // "05/19/2026"
  const slashed = DateTime.fromFormat(trimmed, 'MM/dd/yyyy', { zone: timezone });
  if (slashed.isValid) return slashed.startOf('day');

  return null;
}

/** Every supported relative form, listed in the unsupported-expression error. */
const SUPPORTED_RELATIVE_FORMS =
  '"today", "tomorrow", "yesterday", "next Monday", "this Friday", ' +
  '"Monday of the week of May 18", "Monday after May 15"';

/**
 * Resolve a relative date expression to an absolute date.
 *
 * Supported patterns:
 *   - "today", "tomorrow", "yesterday"      → relative to today in the configured timezone
 *   - "next Monday", "next Friday"          → the coming occurrence (never today)
 *   - "this Monday", "this Friday"          → this week's occurrence (may be today or past)
 *   - "Monday of the week of May 18"        → the Monday of the week containing May 18
 *   - "Monday after May 15"                 → the first Monday strictly after May 15
 */
function resolveRelative(raw: string, now: DateTime, timezone: string): DateTime | null {
  const lower = raw.trim().toLowerCase();

  // "today" / "tomorrow" / "yesterday". `now` is already in the configured zone, so the
  // calendar day is the local one even when the UTC date differs (near midnight), and
  // luxon's day arithmetic steps by calendar day across DST changes. Whole-input match
  // only, so "the day after tomorrow" is rejected rather than read as "tomorrow".
  // The word list is shared with the calendar brief check (src/time/relative-days.ts).
  const dayOffset = RELATIVE_DAY_OFFSETS.get(lower);
  if (dayOffset !== undefined) {
    return now.plus({ days: dayOffset }).startOf('day');
  }

  // "next <day>" — the soonest future occurrence, never today
  const nextMatch = lower.match(/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (nextMatch) {
    // The capture group is required (always present when the match succeeds) and the
    // regex only matches the seven day names that DAY_TO_WEEKDAY is keyed by — so both
    // the index and the lookup are guaranteed (noUncheckedIndexedAccess types the group
    // as `string | undefined` and the Record lookup as `number | undefined`). This same
    // pairing of assertions repeats for the other relative-date patterns below.
    const targetWeekday = DAY_TO_WEEKDAY[nextMatch[1]!]!;
    const daysAhead = ((targetWeekday - now.weekday + 7) % 7) || 7;
    return now.plus({ days: daysAhead }).startOf('day');
  }

  // "this <day>" — this week's occurrence (ISO week: Mon=1)
  const thisMatch = lower.match(/^this\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (thisMatch) {
    const targetWeekday = DAY_TO_WEEKDAY[thisMatch[1]!]!;
    const diff = targetWeekday - now.weekday;
    return now.plus({ days: diff }).startOf('day');
  }

  // "<day> of the week of <date>" — find the ISO week containing <date>, return the requested day
  const weekOfMatch = lower.match(
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+of\s+the\s+week\s+of\s+(.+)$/,
  );
  if (weekOfMatch) {
    const targetWeekday = DAY_TO_WEEKDAY[weekOfMatch[1]!]!;
    const anchor = parseDate(weekOfMatch[2]!, timezone);
    if (!anchor) return null;
    // Find Monday of the anchor's week, then jump to target day
    const monday = anchor.startOf('week'); // luxon ISO: Monday
    return monday.plus({ days: targetWeekday - 1 }).startOf('day');
  }

  // "<day> after <date>" — the first occurrence of <day> strictly after <date>
  const afterMatch = lower.match(
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+after\s+(.+)$/,
  );
  if (afterMatch) {
    const targetWeekday = DAY_TO_WEEKDAY[afterMatch[1]!]!;
    const anchor = parseDate(afterMatch[2]!, timezone);
    if (!anchor) return null;
    const daysAhead = ((targetWeekday - anchor.weekday + 7) % 7) || 7;
    return anchor.plus({ days: daysAhead }).startOf('day');
  }

  return null;
}

/** Normalize a day-of-week string to canonical form ("monday" → "Monday"). */
function canonicalDay(input: string): DayName | null {
  const lower = input.trim().toLowerCase();
  for (const name of DAY_NAMES) {
    if (name.toLowerCase() === lower) return name;
  }
  return null;
}

export class DateResolveHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = (ctx.input ?? {}) as Record<string, unknown>;
    const dateInput = typeof input.date === 'string' ? input.date.trim() : '';
    const relativeInput = typeof input.relative === 'string' ? input.relative.trim() : '';
    const expectedDayInput = typeof input.expected_day === 'string' ? input.expected_day.trim() : '';

    if (!dateInput && !relativeInput) {
      return { success: false, error: "Provide either 'date' (e.g. '2026-05-19') or 'relative' (e.g. 'next Monday')" };
    }

    const timezone = ctx.timezone ?? 'UTC';
    const now = DateTime.now().setZone(timezone);
    // luxon returns an invalid DateTime for an unknown zone instead of throwing. Left
    // unchecked, dates fail with a misleading "could not parse" and relative forms throw
    // later from formatDisplayTimezone. Startup validates TIMEZONE, so this is a guard
    // for callers outside the execution layer, and it names the real problem.
    if (!now.isValid) {
      // A config problem the model can't fix, so make sure operators see it too.
      ctx.log.error({ timezone, invalidReason: now.invalidReason }, 'date-resolve: invalid timezone');
      return { success: false, error: `Invalid timezone: "${timezone}" (${now.invalidReason ?? 'unknown reason'})` };
    }

    let resolved: DateTime | null = null;

    if (dateInput) {
      resolved = parseDate(dateInput, timezone);
      if (!resolved) {
        return { success: false, error: `Could not parse date: "${dateInput}". Use ISO (2026-05-19) or natural (May 19, 2026) format.` };
      }
    } else {
      resolved = resolveRelative(relativeInput, now, timezone);
      if (!resolved) {
        // A bare weekday gets its own error rather than the generic one: the calendar
        // brief check requires a resolved date for "Friday", so the model needs to know
        // which explicit form to call with. Picking one here would hide the ambiguity.
        const bareWeekday = canonicalDay(relativeInput);
        if (bareWeekday) {
          return {
            success: false,
            error:
              `"${relativeInput}" on its own is ambiguous. Use "this ${bareWeekday}" (this week's, ` +
              `may be today or already past) or "next ${bareWeekday}" (the coming one, never today).`,
          };
        }
        return {
          success: false,
          error: `Could not resolve relative expression: "${relativeInput}". Supported: ${SUPPORTED_RELATIVE_FORMS}.`,
        };
      }
    }

    const dayOfWeek = resolved.toFormat('cccc'); // e.g. "Tuesday"
    const isoDate = resolved.toFormat('yyyy-MM-dd'); // e.g. "2026-05-19"
    const formatted = resolved.toFormat('cccc, MMMM d, yyyy'); // e.g. "Tuesday, May 19, 2026"

    const result: Record<string, unknown> = {
      date: isoDate,
      day_of_week: dayOfWeek,
      formatted,
      // Included so the LLM can label timezone context in its response,
      // consistent with other skills that return formatted date/time output.
      // Labelled from the resolved date, not the call time, so a December date asked
      // about in May reads EST. Midday rather than midnight: DST changes happen in the
      // small hours, so midday's offset is the one that covers most of the day.
      displayTimezone: ctx.timezone
        ? formatDisplayTimezone(ctx.timezone, resolved.set({ hour: 12 }).toJSDate())
        : null,
    };

    // Verification mode: check expected day-of-week
    if (expectedDayInput) {
      const canonical = canonicalDay(expectedDayInput);
      if (!canonical) {
        return { success: false, error: `Unrecognized day name: "${expectedDayInput}". Use full English day names (Monday, Tuesday, etc.)` };
      }
      result.expected_day = canonical;
      result.correct = dayOfWeek === canonical;
    }

    ctx.log.info({ date: isoDate, dayOfWeek, relative: relativeInput || undefined }, 'date-resolve: resolved');

    return { success: true, data: result };
  }
}
