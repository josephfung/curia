// skills/calendar-update-event/handler.ts
//
// Updates an existing calendar event with partial field changes.
// Checks the read-only flag before attempting the update.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

export class CalendarUpdateEventHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarId, eventId, title, start, end, description, location, attendees, conferencing } = ctx.input as {
      calendarId?: string;
      eventId?: string;
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
    if (!eventId || typeof eventId !== 'string') {
      return { success: false, error: 'Missing required input: eventId' };
    }

    try {
      // Read-only check — moved inside try so DB errors from resolveCalendar are caught with skill-level context.
      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(calendarId);
        if (registry?.readOnly) {
          return { success: false, error: 'Calendar is read-only' };
        }
      }

      const changes: Record<string, unknown> = {};
      if (title !== undefined) changes.title = title;
      if (start !== undefined) {
        if (!start) return { success: false, error: 'Invalid input: start must be a non-empty string' };
        changes.start = start;
      }
      if (end !== undefined) {
        if (!end) return { success: false, error: 'Invalid input: end must be a non-empty string' };
        changes.end = end;
      }
      if (description !== undefined) changes.description = description;
      if (location !== undefined) changes.location = location;
      if (attendees !== undefined) {
        if (!Array.isArray(attendees)) return { success: false, error: 'Invalid input: attendees must be an array' };
        changes.attendees = attendees;
      }
      if (conferencing !== undefined) changes.conferencing = conferencing;

      // Guard against silent no-ops — require at least one field to update.
      if (Object.keys(changes).length === 0) {
        return { success: false, error: 'No fields provided to update — at least one of title, start, end, description, location, attendees, or conferencing is required' };
      }

      const event = await ctx.nylasCalendarClient.updateEvent(calendarId, eventId, changes);
      ctx.log.info({ calendarId, eventId }, 'Updated calendar event');
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
      ctx.log.error({ err, calendarId, eventId }, 'Failed to update event');
      return { success: false, error: `Failed to update event: ${message}` };
    }
  }
}
