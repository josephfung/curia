// time-context.ts — helpers for injecting current date/time into agent system prompts.
//
// Called once per task turn (not at bootstrap) so the date never goes stale.
// The coordinator's runtime appends formatTimeContextBlock() to the system prompt
// on every processTask() call — mirroring the autonomy block pattern.

import { DateTime } from 'luxon';

/**
 * Format a human-readable date string for the coordinator's system prompt.
 * e.g. "Monday, April 6, 2026"
 *
 * Uses luxon to interpret `now` in the given timezone, so DST transitions are
 * handled correctly (e.g. midnight UTC is the previous calendar day in Toronto
 * during winter when the offset is UTC-5).
 */
export function formatCurrentDate(now: Date, timezone: string): string {
  return DateTime.fromJSDate(now, { zone: timezone })
    .toFormat('cccc, MMMM d, yyyy');
}

/**
 * Format the full time-context block appended to the system prompt each turn.
 * Includes date, time, and timezone name with DST abbreviation and UTC offset.
 *
 * Example output:
 *   ## Current Date & Time
 *   Date: Monday, April 6, 2026
 *   Time: 08:32 AM
 *   Timezone: America/Toronto (EDT, UTC-4)
 */
export function formatTimeContextBlock(timezone: string, now: Date): string {
  const dt = DateTime.fromJSDate(now, { zone: timezone });
  const date = dt.toFormat('cccc, MMMM d, yyyy');
  const time = dt.toFormat('hh:mm a');
  // e.g. "EDT" (DST-aware abbreviation)
  const abbr = dt.toFormat('ZZZZ');
  // dt.offset is minutes; convert to hours for display
  const offsetHours = dt.offset / 60;
  const offsetLabel = offsetHours === 0
    ? 'UTC'
    : offsetHours > 0
      ? `UTC+${offsetHours}`
      : `UTC${offsetHours}`;

  return [
    '## Current Date & Time',
    `Date: ${date}`,
    `Time: ${time}`,
    `Timezone: ${timezone} (${abbr}, ${offsetLabel})`,
  ].join('\n');
}
