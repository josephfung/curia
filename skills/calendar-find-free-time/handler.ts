// skills/calendar-find-free-time/handler.ts
//
// Finds free time windows across one or more calendars by inverting
// the busy periods returned by the Nylas free/busy API.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

export class CalendarFindFreeTimeHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarIds, timeMin, timeMax, duration } = ctx.input as {
      calendarIds?: string[];
      timeMin?: string;
      timeMax?: string;
      duration?: number;
    };

    if (!calendarIds || !Array.isArray(calendarIds) || calendarIds.length === 0) {
      return { success: false, error: 'Missing required input: calendarIds (must be a non-empty array)' };
    }
    if (!timeMin || typeof timeMin !== 'string') {
      return { success: false, error: 'Missing required input: timeMin' };
    }
    if (!timeMax || typeof timeMax !== 'string') {
      return { success: false, error: 'Missing required input: timeMax' };
    }
    if (isNaN(new Date(timeMin).getTime())) {
      return { success: false, error: 'Invalid input: timeMin is not a valid date' };
    }
    if (isNaN(new Date(timeMax).getTime())) {
      return { success: false, error: 'Invalid input: timeMax is not a valid date' };
    }
    if (new Date(timeMax) <= new Date(timeMin)) {
      return { success: false, error: 'Invalid input: timeMax must be after timeMin' };
    }

    try {
      const freeBusyResults = await ctx.nylasCalendarClient.getFreeBusy(calendarIds, timeMin, timeMax);

      // Collect all busy periods across all calendars
      const allBusy: Array<{ start: number; end: number }> = [];
      for (const result of freeBusyResults) {
        for (const slot of result.timeSlots) {
          allBusy.push({ start: slot.startTime, end: slot.endTime });
        }
      }

      // Sort and merge overlapping busy periods so inversion is clean
      allBusy.sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      for (const slot of allBusy) {
        if (merged.length > 0 && slot.start <= merged[merged.length - 1].end) {
          merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, slot.end);
        } else {
          merged.push({ ...slot });
        }
      }

      // Invert: compute free windows within the requested range
      const rangeStart = Math.floor(new Date(timeMin).getTime() / 1000);
      const rangeEnd = Math.floor(new Date(timeMax).getTime() / 1000);

      const freeWindows: Array<{ start: number; end: number }> = [];
      let cursor = rangeStart;
      for (const busy of merged) {
        if (busy.start > cursor) {
          freeWindows.push({ start: cursor, end: busy.start });
        }
        cursor = Math.max(cursor, busy.end);
      }
      if (cursor < rangeEnd) {
        freeWindows.push({ start: cursor, end: rangeEnd });
      }

      // Filter by minimum duration (duration input is in minutes, convert to seconds for comparison)
      const minSeconds = typeof duration === 'number' ? duration * 60 : 0;
      const filtered = minSeconds > 0
        ? freeWindows.filter((w) => w.end - w.start >= minSeconds)
        : freeWindows;

      // Format timestamps in the user's local timezone so the LLM reads correct
      // wall-clock times. Falls back to UTC Z-suffix when timezone is not configured.
      // Guard non-finite and non-positive values the same way calendar-list-events does.
      const tz = ctx.timezone;
      const formatTs = (unix: number, field: string): string | null => {
        if (!Number.isFinite(unix) || unix <= 0) {
          ctx.log.warn({ value: unix, field }, 'calendar-find-free-time: suspicious timestamp — omitting');
          return null;
        }
        return tz ? toLocalIso(unix, tz) : new Date(unix * 1000).toISOString();
      };
      const freeWindowsFormatted = filtered.map((w) => ({
        start: formatTs(w.start, 'start'),
        end: formatTs(w.end, 'end'),
      }));

      ctx.log.info({ calendarCount: calendarIds.length, freeWindowCount: freeWindowsFormatted.length }, 'Found free time');
      return { success: true, data: { freeWindows: freeWindowsFormatted, displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to find free time');
      return { success: false, error: `Failed to find free time: ${message}` };
    }
  }
}
