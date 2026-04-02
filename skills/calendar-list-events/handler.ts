// skills/calendar-list-events/handler.ts
//
// Fetches events for a date range from one or more calendars, with optional
// client-side filtering by text query or attendee email.
//
// When calendarId is provided, queries that single calendar.
// When omitted, resolves ALL calendars registered to the caller (via
// contactService) and merges events across them — so "what's my agenda?"
// works without the LLM needing to know specific calendar IDs.
//
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

    if (!timeMin || typeof timeMin !== 'string') {
      return { success: false, error: 'Missing required input: timeMin' };
    }
    if (!timeMax || typeof timeMax !== 'string') {
      return { success: false, error: 'Missing required input: timeMax' };
    }

    try {
      // Resolve which calendar(s) to query.
      // If the caller provided a specific calendarId, use that.
      // Otherwise, look up all calendars registered to the caller's contact.
      let calendarIds: string[];

      if (calendarId && typeof calendarId === 'string') {
        calendarIds = [calendarId];
      } else if (ctx.contactService && ctx.caller) {
        const calendars = await ctx.contactService.getCalendarsForContact(ctx.caller.contactId);
        if (calendars.length === 0) {
          return { success: false, error: 'No calendars registered for this contact — register a calendar first' };
        }
        calendarIds = calendars.map((c) => c.nylasCalendarId);
        ctx.log.info({ contactId: ctx.caller.contactId, calendarCount: calendarIds.length }, 'Resolved caller calendars');
      } else {
        return { success: false, error: 'Missing required input: calendarId (and unable to resolve caller calendars)' };
      }

      // Pass maxResults as the upstream fetch limit so callers asking for >200 events aren't silently capped.
      const fetchLimit = typeof maxResults === 'number' && maxResults > 0 ? { limit: maxResults } : undefined;

      // Fetch events from all resolved calendars in parallel, then merge.
      const perCalendarResults = await Promise.all(
        calendarIds.map((cid) => ctx.nylasCalendarClient!.listEvents(cid, timeMin, timeMax, fetchLimit)),
      );
      let events = perCalendarResults.flat();

      // Sort merged events by start time so the agenda reads chronologically
      events.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

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

      ctx.log.info({ calendarIds, count: events.length }, 'Listed events');
      return { success: true, data: { events, count: events.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId }, 'Failed to list events');
      return { success: false, error: `Failed to list events: ${message}` };
    }
  }
}
