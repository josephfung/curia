// skills/calendar-find-free-time/handler.ts
//
// Finds free time windows across one or more calendars. The principal's calendars are read as
// events across every connected account (#2475, D7), so the result can say what blocks and the
// agent can rerun with `treat_as_free`; other people's calendars are read as free/busy.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone, isPlausibleUnixSeconds } from '../../../../src/time/timestamp.js';
import { readCalendarMailbox } from '../../../_shared/calendar-route.js';
import { blockView, calendarIdsCapError, readAvailability } from '../../../_shared/calendar-availability.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';

export class CalendarFindFreeTimeHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.calendarRouter) {
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
    const overCap = calendarIdsCapError(calendarIds);
    if (overCap) return { success: false, error: overCap };
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

    const rangeStart = Math.floor(new Date(timeMin).getTime() / 1000);
    const rangeEnd = Math.floor(new Date(timeMax).getTime() / 1000);
    if (!isPlausibleUnixSeconds(rangeStart)) {
      return { success: false, error: 'Invalid input: timeMin is outside the supported calendar range (after 1970 through 2100-01-01)' };
    }
    if (!isPlausibleUnixSeconds(rangeEnd)) {
      return { success: false, error: 'Invalid input: timeMax is outside the supported calendar range (after 1970 through 2100-01-01)' };
    }

    const treatAsFree = (ctx.input as { treat_as_free?: unknown }).treat_as_free;
    if (treatAsFree !== undefined && (!Array.isArray(treatAsFree) || !treatAsFree.every((x) => typeof x === 'string' && x.trim() !== ''))) {
      return { success: false, error: 'Invalid input: treat_as_free must be an array of event IDs (strings)' };
    }

    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };

    try {
      const availability = await readAvailability(ctx, 'calendar-find-free-time', {
        calendarIds,
        mailbox: mailbox.mailbox,
        timeMin,
        timeMax,
        treatAsFree: treatAsFree as string[] | undefined,
      });
      if (!availability.ok) return { success: false, error: availability.error };
      const read = availability.read;
      if (!read.anyRead) {
        const reasons = read.partial.map((p) => `${p.mailbox_label}: ${p.error}`).join('; ');
        const removed = read.removed.length > 0 ? ` Removed mailboxes: ${read.removed.join(', ')}.` : '';
        return { success: false, error: `Failed to find free time: no calendar could be read${reasons ? ` (${reasons})` : ''}.${removed}` };
      }

      const allBusy = read.blocking.map(({ start, end }) => ({ start, end }));

      // Sort and merge overlapping busy periods so inversion is clean
      allBusy.sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      for (const slot of allBusy) {
        // Capture the last merged entry in a local — a truthy check narrows it from
        // `T | undefined` (noUncheckedIndexedAccess) and replaces the length>0 guard.
        const last = merged[merged.length - 1];
        if (last && slot.start <= last.end) {
          last.end = Math.max(last.end, slot.end);
        } else {
          merged.push({ ...slot });
        }
      }

      // Invert: compute free windows within the requested range
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

      const tz = ctx.timezone;
      const freeWindowsFormatted = filtered.map((w) => ({
        start: toLocalIso(w.start, tz),
        end: toLocalIso(w.end, tz),
      }));

      const data: Record<string, unknown> = {
        freeWindows: freeWindowsFormatted,
        displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
      };
      if (read.principalRead) {
        // What takes the principal's time, so the agent can judge it against their calendaring
        // preferences (the cleaner's visit) and rerun with treat_as_free (D7).
        data['blocking'] = read.blocking.filter((b) => b.principal).map((b) => blockView(b, tz));
        data['treated_as_free'] = read.treatedAsFree.map((b) => blockView(b, tz));
        if (read.treatAsFreeUnmatched.length > 0) data['treat_as_free_unmatched'] = read.treatAsFreeUnmatched;
      }
      if (read.partial.length > 0) data['partial'] = read.partial;
      // A calendar the caller named whose mailbox was removed was not read either (R101).
      const unread = [...read.partial.map((p) => p.mailbox_label), ...read.removedRequested];
      if (unread.length > 0) {
        data['note'] =
          `Not every calendar could be read (${unread.join(', ')}): ` +
          'these windows are free only on the calendars that were read. Say so; do not call them free.';
      }
      if (read.removed.length > 0) data['removed'] = read.removed;
      if (read.readVia.length > 0) data['freebusy_via'] = read.readVia;

      ctx.log.info(
        { calendarCount: calendarIds.length, freeWindowCount: freeWindowsFormatted.length, partialCount: read.partial.length, treatedCount: read.treatedAsFree.length },
        'Found free time',
      );
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...grantSafeErrorFields(err) }, 'Failed to find free time');
      return { success: false, error: `Failed to find free time: ${message}` };
    }
  }
}
