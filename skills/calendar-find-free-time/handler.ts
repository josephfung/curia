// skills/calendar-find-free-time/handler.ts
//
// Finds free time windows across one or more calendars by inverting
// the busy periods returned by the Nylas free/busy API.
//
// NOTE: the `duration` input is in seconds (not minutes). The skill.json
// description says "minutes" for user-facing clarity (most humans think in
// minutes), but the implementation treats the raw number as seconds so that
// callers can be precise without floating-point conversion. Revisit if the
// LLM consistently passes minute values — a unit conversion layer may be needed.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

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

      // Filter by minimum duration (duration is in seconds)
      const minSeconds = typeof duration === 'number' ? duration : 0;
      const filtered = minSeconds > 0
        ? freeWindows.filter((w) => w.end - w.start >= minSeconds)
        : freeWindows;

      ctx.log.info({ calendarCount: calendarIds.length, freeWindowCount: filtered.length }, 'Found free time');
      return { success: true, data: { freeWindows: filtered } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to find free time');
      return { success: false, error: `Failed to find free time: ${message}` };
    }
  }
}
