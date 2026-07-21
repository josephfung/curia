// skills/calendar-create-event/handler.ts
//
// Creates a new calendar event. Checks the read-only flag from the calendar
// registry before attempting creation. If the calendar is unregistered,
// proceeds anyway — the Nylas API will enforce its own permissions.
//
// After a successful booking, performs self-release: any curia-hold events that
// overlap the new slot are deleted. This is a best-effort, fire-and-forget step
// that MUST NOT fail the booking — if anything goes wrong here, we warn and continue.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { CreateEventInput } from '../../src/channels/calendar/nylas-calendar-client.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import { isHoldEvent, eventsOverlap } from '../../src/channels/calendar/holds.js';

export class CalendarCreateEventHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarId, title, start, end, description, location, attendees, conferencing } = ctx.input as {
      calendarId?: string;
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      attendees?: Array<{ email: string; name?: string }>;
      conferencing?: Record<string, unknown>;
    };

    if (!calendarId || typeof calendarId !== 'string') {
      return { success: false, error: 'Missing required input: calendarId' };
    }
    if (!title || typeof title !== 'string') {
      return { success: false, error: 'Missing required input: title' };
    }
    if (!start || typeof start !== 'string') {
      return { success: false, error: 'Missing required input: start' };
    }
    if (!end || typeof end !== 'string') {
      return { success: false, error: 'Missing required input: end' };
    }
    if (isNaN(new Date(start).getTime())) {
      return { success: false, error: 'Invalid input: start is not a valid date' };
    }
    if (isNaN(new Date(end).getTime())) {
      return { success: false, error: 'Invalid input: end is not a valid date' };
    }
    if (new Date(end) <= new Date(start)) {
      return { success: false, error: 'Invalid input: end must be after start' };
    }
    if (attendees !== undefined && !Array.isArray(attendees)) {
      return { success: false, error: 'Invalid input: attendees must be an array' };
    }

    try {
      // Read-only check: if the calendar is registered and marked read-only, refuse.
      // Unregistered calendars (null) proceed — Nylas enforces its own permissions.
      // Moved inside try so DB errors from resolveCalendar are caught with skill-level context.
      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(calendarId);
        if (registry?.readOnly) {
          return { success: false, error: 'Calendar is read-only' };
        }
      }

      const eventData: CreateEventInput = { title, start, end };
      if (description) eventData.description = description;
      if (location) eventData.location = location;
      if (attendees) eventData.attendees = attendees;
      if (conferencing) eventData.conferencing = conferencing;

      const event = await ctx.nylasCalendarClient.createEvent(calendarId, eventData);
      ctx.log.info({ calendarId, eventId: event.id }, 'Created calendar event');

      // Self-release: a real booking supersedes any tentative holds we placed on the
      // same slot. List overlapping events and delete only our own curia-hold events.
      // Failure here must never fail the booking — the event is already created.
      // The outer try/catch guards listEvents; the inner per-event try/catch ensures
      // one failing deleteEvent doesn't abort the rest of the loop.
      try {
        const startUnix = Math.floor(new Date(start).getTime() / 1000);
        const endUnix = Math.floor(new Date(end).getTime() / 1000);
        const overlapping = await ctx.nylasCalendarClient.listEvents(calendarId, start, end);
        for (const e of overlapping) {
          if (e.id === event.id) continue;           // skip the event we just created
          if (!isHoldEvent(e)) continue;             // skip real (non-hold) events
          if (e.startTime === null || e.endTime === null) continue;  // skip malformed holds
          if (!eventsOverlap(startUnix, endUnix, e.startTime, e.endTime)) continue; // skip non-overlapping
          // Per-event try/catch: one failing delete must not abort the rest of the loop.
          // A transient Nylas error on one hold should not prevent releasing the others.
          try {
            await ctx.nylasCalendarClient.deleteEvent(calendarId, e.id, false); // notifyAttendees=false — holds have no attendees
            ctx.log.info({ releasedHoldId: e.id, bookedEventId: event.id }, 'calendar-create-event: released overlapping hold');
          } catch (err) {
            ctx.log.warn({ err, holdId: e.id, bookedEventId: event.id }, 'calendar-create-event: failed to release overlapping hold, continuing');
          }
        }
      } catch (err) {
        ctx.log.warn({ err, bookedEventId: event.id }, 'calendar-create-event: hold self-release failed (booking unaffected)');
      }

      // Format timestamps in the user's local timezone so the confirmation matches
      // what calendar-list-events returns. toLocalIso handles null/invalid values internally.
      const tz = ctx.timezone;
      return {
        success: true,
        data: {
          event: {
            ...event,
            startTime: toLocalIso(event.startTime, tz),
            endTime: toLocalIso(event.endTime, tz),
          },
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId }, 'Failed to create event');
      return { success: false, error: `Failed to create event: ${message}` };
    }
  }
}
