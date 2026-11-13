// skills/calendar-update-event/handler.ts
//
// Updates an existing calendar event with partial field changes.
// Checks the read-only flag before attempting the update.
//
// Guest-list writes replace the entire attendee array (email + optional name).
// This Nylas tool does not set RSVP status; first-person RSVP is
// calendar-respond-to-invite (sendRsvp).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { CreateEventInput } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import { isNylasBadRequest } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import {
  parseWritableAttendees,
  collectGuestListMismatches,
  guestListMismatchWarnings,
} from '../../../../src/channels/calendar/attendee-input.js';
import { formatDisplayTimezone } from '../../../../src/time/timestamp.js';
import { localizeEventTimes } from '../../../../src/channels/calendar/event-display.js';
import { parseRecurrence } from '../../../../src/channels/calendar/recurrence-input.js';
import { parseConferencing } from '../../../../src/channels/calendar/conferencing-input.js';
import { undeclaredInputError } from '../../../../src/skills/_shared/undeclared-input-guard.js';
import { readCalendarMailbox, routeCalendar } from '../../../_shared/calendar-route.js';

// Mirrors tool.json `inputs`. Anything else is refused rather than silently dropped (#2385).
const DECLARED_INPUTS = [
  'calendarId', 'eventId', 'title', 'start', 'end', 'description', 'location', 'attendees',
  'conferencing', 'recurrence', 'notifyAttendees', 'mailbox',
] as const;

export class CalendarUpdateEventHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.calendarRouter) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const undeclared = undeclaredInputError(ctx.input, DECLARED_INPUTS);
    if (undeclared) return { success: false, error: undeclared };

    const { calendarId, eventId, title, start, end, description, location, attendees, conferencing, recurrence, notifyAttendees } = ctx.input as {
      calendarId?: string;
      eventId?: string;
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      attendees?: unknown;
      conferencing?: unknown;
      recurrence?: unknown;
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

    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };

    try {
      // The mailbox the calendar belongs to (#2475); `primary` becomes its home calendar's ID.
      const route = await routeCalendar(ctx, 'calendar-update-event', calendarId, mailbox.mailbox);
      if (!route.ok) return { success: false, error: route.error };
      const { client, calendarId: targetCalendarId } = route.routed;

      // Read-only check — moved inside try so DB errors from resolveCalendar are caught with skill-level context.
      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(targetCalendarId);
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
        const parsed = parseWritableAttendees(attendees);
        if (!parsed.ok) return { success: false, error: parsed.error };
        changes.attendees = parsed.attendees;
      }
      if (conferencing !== undefined) {
        const parsed = parseConferencing(conferencing);
        if (!parsed.ok) return { success: false, error: parsed.error };
        changes.conferencing = parsed.conferencing;
      }
      if (recurrence !== undefined) {
        if (!ctx.timezone) {
          return { success: false, error: 'Cannot change a recurrence rule: no timezone is configured for Curia' };
        }
        // Validate shape first so a malformed rule costs no Nylas call.
        const shape = parseRecurrence(recurrence, { timezone: ctx.timezone });
        if (!shape.ok) return { success: false, error: shape.error };
        // An update replaces the series' rule lines, and nothing here confirms an
        // EXDATE/RDATE took effect. Cancelling one occurrence is a delete by its id.
        if (shape.recurrence.some((line) => !line.startsWith('RRULE:'))) {
          return {
            success: false,
            error: 'On update, recurrence takes the RRULE line only. To cancel one occurrence, use calendar-delete-event with that occurrence\'s id. Nothing was changed.',
          };
        }
        // The rule lives on the series master. An instance id here would at best
        // detach that one occurrence, so refuse and name the master instead.
        const target = await client.getEvent(targetCalendarId, eventId);
        if (target.masterEventId) {
          return {
            success: false,
            error: `Event '${eventId}' is one occurrence of a recurring series. Change the rule on the series by passing its master event id '${target.masterEventId}' as eventId. Nothing was changed.`,
          };
        }
        if (target.startTime === null || target.endTime === null) {
          return { success: false, error: `Event '${eventId}' is an all-day event; recurring all-day events are not supported. Nothing was changed.` };
        }
        // Nylas needs a complete `when` (both times plus timezones) alongside a rule,
        // so fill whichever bound the caller left out, keeping the event's duration.
        const durationMs = (target.endTime - target.startTime) * 1000;
        for (const [name, value] of [['start', changes.start], ['end', changes.end]] as const) {
          if (value !== undefined && Number.isNaN(Date.parse(value))) {
            return { success: false, error: `Invalid input: ${name} "${value}" is not a valid date` };
          }
        }
        if (changes.start === undefined && changes.end === undefined) {
          changes.start = new Date(target.startTime * 1000).toISOString();
          changes.end = new Date(target.endTime * 1000).toISOString();
        } else if (changes.end === undefined) {
          changes.end = new Date(Date.parse(changes.start!) + durationMs).toISOString();
        } else if (changes.start === undefined) {
          changes.start = new Date(Date.parse(changes.end) - durationMs).toISOString();
        }
        // Check the rule against the start the series will have after this write.
        const parsed = parseRecurrence(recurrence, { start: changes.start, timezone: ctx.timezone });
        if (!parsed.ok) return { success: false, error: parsed.error };
        changes.recurrence = parsed.recurrence;
        changes.timezone = ctx.timezone;
      }

      // Guard against silent no-ops — require at least one field to update.
      if (Object.keys(changes).length === 0) {
        return { success: false, error: 'No fields provided to update — at least one of title, start, end, description, location, attendees, conferencing, or recurrence is required' };
      }

      const event = await client.updateEvent(
        targetCalendarId,
        eventId,
        changes,
        notifyAttendees,
      );

      const warnings: string[] = [];
      if (changes.attendees) {
        const { missing, extra } = collectGuestListMismatches(changes.attendees, event.participants);
        warnings.push(...guestListMismatchWarnings(missing, extra));
        if (missing.length > 0 || extra.length > 0) {
          ctx.log.warn(
            { calendarId, eventId, missingCount: missing.length, extraCount: extra.length },
            'calendar-update-event: provider guest list did not match the request',
          );
        }
      }
      if (notifyAttendees === false) {
        warnings.push(
          'notifyAttendees=false is honoured by Google Calendar; iCloud ignores it and still emails attendees.',
        );
      }

      ctx.log.info({ calendarId, eventId }, 'Updated calendar event');
      // Format timestamps in the user's local timezone so the confirmation matches
      // what calendar-list-events returns. toLocalIso handles null/invalid values internally.
      const tz = ctx.timezone;
      return {
        success: true,
        data: {
          event: localizeEventTimes(event, tz),
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId, eventId }, 'Failed to update event');
      // Microsoft rejects notify_participants=false with a 400. Say so, rather than
      // let the agent retry silently or drop the flag and email attendees unasked.
      // Only a 400 proves nothing changed; a timeout or 5xx leaves the outcome unknown.
      const hint = notifyAttendees === false && isNylasBadRequest(err)
        ? ' Microsoft calendars reject notifyAttendees=false. The event was not changed; ask the principal before retrying with attendees notified.'
        : '';
      return { success: false, error: `Failed to update event: ${message}${hint}` };
    }
  }
}
