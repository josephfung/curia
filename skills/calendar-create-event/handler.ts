// skills/calendar-create-event/handler.ts
//
// Creates a new calendar event. Checks the read-only flag from the calendar
// registry before attempting creation. If the calendar is unregistered,
// proceeds anyway — the Nylas API will enforce its own permissions.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { CreateEventInput } from '../../src/channels/calendar/nylas-calendar-client.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

export class CalendarCreateEventHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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
      // Format timestamps in the user's local timezone so the confirmation matches what
      // calendar-list-events returns. Falls back to UTC Z-suffix when timezone is not configured.
      // Defensive fallback on bad timezone: the event was already written — a misconfigured
      // ctx.timezone must not falsely report failure.
      const tz = ctx.timezone;
      const toIso = (unix: number | null, field: string): string | null => {
        if (unix === null) return null;
        if (!Number.isFinite(unix) || unix <= 0) {
          ctx.log.warn({ eventId: event.id, field, value: unix }, `calendar-create-event: suspicious ${field} value — omitting`);
          return null;
        }
        if (tz) {
          try {
            return toLocalIso(unix, tz);
          } catch {
            ctx.log.warn({ tz }, 'calendar-create-event: invalid timezone — falling back to UTC');
            return new Date(unix * 1000).toISOString();
          }
        }
        return new Date(unix * 1000).toISOString();
      };
      let displayTimezone: string | null = null;
      if (tz) {
        try {
          displayTimezone = formatDisplayTimezone(tz, new Date());
        } catch {
          ctx.log.warn({ tz }, 'calendar-create-event: invalid timezone for displayTimezone');
        }
      }
      return {
        success: true,
        data: {
          event: {
            ...event,
            startTime: toIso(event.startTime, 'startTime'),
            endTime: toIso(event.endTime, 'endTime'),
          },
          displayTimezone,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId }, 'Failed to create event');
      return { success: false, error: `Failed to create event: ${message}` };
    }
  }
}
