// skills/calendar-create-event/handler.ts
//
// Creates a new calendar event. Checks the read-only flag from the calendar
// registry before attempting creation. If the calendar is unregistered,
// proceeds anyway — the Nylas API will enforce its own permissions.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { CreateEventInput } from '../../src/channels/calendar/nylas-calendar-client.js';

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
      return { success: true, data: { event } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId }, 'Failed to create event');
      return { success: false, error: `Failed to create event: ${message}` };
    }
  }
}
