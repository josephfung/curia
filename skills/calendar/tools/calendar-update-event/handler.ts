// skills/calendar-update-event/handler.ts
//
// Updates an existing calendar event with partial field changes.
// Checks the read-only flag before attempting the update.
//
// Guest-list writes replace the entire attendee array (email + optional name).
// Organizer-set RSVP status is not supported: Nylas rejects it on PUT, and
// Microsoft Graph cannot set another attendee's response. First-person RSVP
// is calendar-respond-to-invite (sendRsvp).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { CalendarAttendeeInput, CreateEventInput } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';

const RSVP_STATUS_KEYS = ['status', 'responseStatus', 'participationStatus'] as const;

const ATTENDEE_STATUS_UNSUPPORTED =
  'Attendee response status cannot be set through calendar-update-event. ' +
  'Nylas rejects organizer-set participant status on event update; Microsoft Graph cannot set another attendee\'s response; ' +
  'only the authenticated principal can RSVP, via calendar-respond-to-invite. ' +
  'Pass attendees as email and optional name to replace the guest list.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAttendees(raw: unknown): { ok: true; attendees: CalendarAttendeeInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Invalid input: attendees must be an array' };
  }
  const attendees: CalendarAttendeeInput[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      return { ok: false, error: 'Invalid input: each attendee must be an object with email and optional name' };
    }
    if (RSVP_STATUS_KEYS.some((key) => key in item)) {
      return { ok: false, error: ATTENDEE_STATUS_UNSUPPORTED };
    }
    if (typeof item.email !== 'string' || item.email.trim() === '') {
      return { ok: false, error: 'Invalid input: each attendee must have a non-empty email' };
    }
    if (item.name !== undefined && typeof item.name !== 'string') {
      return { ok: false, error: 'Invalid input: attendee name must be a string when provided' };
    }
    const attendee: CalendarAttendeeInput = { email: item.email.trim() };
    if (typeof item.name === 'string') attendee.name = item.name;
    attendees.push(attendee);
  }
  return { ok: true, attendees };
}

function missingRequestedEmails(
  requested: CalendarAttendeeInput[],
  returned: Array<{ email: string }>,
): string[] {
  const returnedSet = new Set(returned.map((p) => p.email.trim().toLowerCase()));
  const missing: string[] = [];
  for (const attendee of requested) {
    const email = attendee.email.trim().toLowerCase();
    if (!returnedSet.has(email)) missing.push(email);
  }
  return missing;
}

export class CalendarUpdateEventHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarId, eventId, title, start, end, description, location, attendees, conferencing, notifyAttendees } = ctx.input as {
      calendarId?: string;
      eventId?: string;
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      attendees?: unknown;
      conferencing?: Record<string, unknown>;
      notifyAttendees?: unknown;
    };

    if (!calendarId || typeof calendarId !== 'string') {
      return { success: false, error: 'Missing required input: calendarId' };
    }
    if (!eventId || typeof eventId !== 'string') {
      return { success: false, error: 'Missing required input: eventId' };
    }
    if (notifyAttendees !== undefined && typeof notifyAttendees !== 'boolean') {
      return { success: false, error: 'Invalid input: notifyAttendees must be a boolean' };
    }

    try {
      // Read-only check — moved inside try so DB errors from resolveCalendar are caught with skill-level context.
      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(calendarId);
        if (registry?.readOnly) {
          return { success: false, error: 'Calendar is read-only' };
        }
      }

      const changes: Partial<CreateEventInput> = {};
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
        const parsed = parseAttendees(attendees);
        if (!parsed.ok) return { success: false, error: parsed.error };
        changes.attendees = parsed.attendees;
      }
      if (conferencing !== undefined) changes.conferencing = conferencing;

      // Guard against silent no-ops — require at least one field to update.
      if (Object.keys(changes).length === 0) {
        return { success: false, error: 'No fields provided to update — at least one of title, start, end, description, location, attendees, or conferencing is required' };
      }

      const event = await ctx.nylasCalendarClient.updateEvent(
        calendarId,
        eventId,
        changes,
        notifyAttendees,
      );

      if (changes.attendees) {
        const missing = missingRequestedEmails(changes.attendees, event.participants);
        if (missing.length > 0) {
          ctx.log.error(
            { calendarId, eventId, missingCount: missing.length },
            'calendar-update-event: provider response omitted requested attendees',
          );
          return {
            success: false,
            error:
              `Failed to update event: provider response did not include ${missing.length} requested attendee(s). ` +
              'The guest list replace may not have applied. Re-read the event before retrying.',
          };
        }
      }

      ctx.log.info({ calendarId, eventId }, 'Updated calendar event');
      // Format timestamps in the user's local timezone so the confirmation matches
      // what calendar-list-events returns. toLocalIso handles null/invalid values internally.
      const tz = ctx.timezone;
      const warnings: string[] = [];
      if (notifyAttendees === false) {
        warnings.push(
          'notifyAttendees=false is honoured by Google Calendar; Microsoft and iCloud ignore it and still email attendees.',
        );
      }
      return {
        success: true,
        data: {
          event: {
            ...event,
            startTime: toLocalIso(event.startTime, tz),
            endTime: toLocalIso(event.endTime, tz),
          },
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId, eventId }, 'Failed to update event');
      return { success: false, error: `Failed to update event: ${message}` };
    }
  }
}
