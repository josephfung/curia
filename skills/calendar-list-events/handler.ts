// skills/calendar-list-events/handler.ts
//
// Fetches events for a date range from a specific calendar, with optional
// client-side filtering by text query or attendee email.
// Nylas doesn't support server-side text search on event fields, so
// the skill fetches all events in range and filters locally.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class CalendarListEventsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarId, timeMin, timeMax, maxResults, query, attendeeEmail } = ctx.input as {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
      query?: string;
      attendeeEmail?: string;
    };

    if (!calendarId || typeof calendarId !== 'string') {
      return { success: false, error: 'Missing required input: calendarId' };
    }
    if (!timeMin || typeof timeMin !== 'string') {
      return { success: false, error: 'Missing required input: timeMin' };
    }
    if (!timeMax || typeof timeMax !== 'string') {
      return { success: false, error: 'Missing required input: timeMax' };
    }

    try {
      let events = await ctx.nylasCalendarClient.listEvents(calendarId, timeMin, timeMax);

      // Client-side filtering: query matches title or description (case-insensitive)
      if (query && typeof query === 'string') {
        const lowerQuery = query.toLowerCase();
        events = events.filter(
          (evt) =>
            evt.title.toLowerCase().includes(lowerQuery) ||
            evt.description.toLowerCase().includes(lowerQuery),
        );
      }

      // Client-side filtering: attendee email
      if (attendeeEmail && typeof attendeeEmail === 'string') {
        const lowerEmail = attendeeEmail.toLowerCase();
        events = events.filter(
          (evt) => evt.participants.some((p) => p.email.toLowerCase() === lowerEmail),
        );
      }

      // Truncate if maxResults is set
      if (typeof maxResults === 'number' && maxResults > 0) {
        events = events.slice(0, maxResults);
      }

      ctx.log.info({ calendarId, count: events.length }, 'Listed events');
      return { success: true, data: { events, count: events.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId }, 'Failed to list events');
      return { success: false, error: `Failed to list events: ${message}` };
    }
  }
}
