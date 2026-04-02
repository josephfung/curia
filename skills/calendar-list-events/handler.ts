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
    const calendarClient = ctx.nylasCalendarClient;
    if (!calendarClient) {
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
      // Use allSettled so one bad calendar (stale grant, revoked access) doesn't
      // poison the entire result — return partial results and log failures.
      const settled = await Promise.allSettled(
        calendarIds.map((cid) => calendarClient.listEvents(cid, timeMin, timeMax, fetchLimit)),
      );

      const failedCalendarIds: string[] = [];
      const successfulEvents: Array<typeof settled[0] extends PromiseFulfilledResult<infer T> ? T : never> = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === 'fulfilled') {
          successfulEvents.push(result.value);
        } else {
          failedCalendarIds.push(calendarIds[i]);
          ctx.log.error({ err: result.reason, calendarId: calendarIds[i] }, 'Failed to fetch events for calendar');
        }
      }

      if (successfulEvents.length === 0) {
        const message = failedCalendarIds.length > 0
          ? `Failed to list events from any calendar (${failedCalendarIds.length} failed: ${failedCalendarIds.join(', ')})`
          : 'No events found';
        return { success: false, error: message };
      }

      let events = successfulEvents.flat();

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

      ctx.log.info({ calendarIds, count: events.length, failedCalendarIds }, 'Listed events');
      const data: Record<string, unknown> = { events, count: events.length };
      // Surface partial failures so the LLM can inform the user
      if (failedCalendarIds.length > 0) {
        data.warnings = [`Failed to fetch events from ${failedCalendarIds.length} calendar(s): ${failedCalendarIds.join(', ')}`];
      }
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId }, 'Failed to list events');
      return { success: false, error: `Failed to list events: ${message}` };
    }
  }
}
