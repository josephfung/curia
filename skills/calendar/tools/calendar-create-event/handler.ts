// skills/calendar-create-event/handler.ts
//
// Creates a new calendar event. Checks the read-only flag from the calendar
// registry before attempting creation. If the calendar is unregistered,
// proceeds anyway — the Nylas API will enforce its own permissions.
//
// After a successful booking, performs self-release: any curia-hold events that
// overlap the new slot are deleted. This is a best-effort, fire-and-forget step
// that MUST NOT fail the booking — if anything goes wrong here, we warn and continue.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { CreateEventInput } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import { parseWritableAttendees } from '../../../../src/channels/calendar/attendee-input.js';
import { formatDisplayTimezone } from '../../../../src/time/timestamp.js';
import { localizeEventTimes } from '../../../../src/channels/calendar/event-display.js';
import { holdHasAttendees, isHoldEvent, eventsOverlap } from '../../../../src/channels/calendar/holds.js';
import { parseRecurrence } from '../../../../src/channels/calendar/recurrence-input.js';
import { parseConferencing } from '../../../../src/channels/calendar/conferencing-input.js';
import { undeclaredInputError } from '../../../../src/skills/_shared/undeclared-input-guard.js';
import {
  evidenceRecipients,
  evidenceVerdict,
  gateCalendarWrite,
  holdReleaseTargets,
  needsMailboxResult,
  readCalendarMailbox,
} from '../../../_shared/calendar-route.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';

const TOOL = 'calendar-create-event';

// Mirrors tool.json `inputs`. Anything else is refused rather than silently dropped (#2385).
const DECLARED_INPUTS = [
  'calendarId', 'title', 'start', 'end', 'description', 'location', 'attendees', 'conferencing', 'recurrence',
  'mailbox',
] as const;

export class CalendarCreateEventHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.calendarRouter) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const undeclared = undeclaredInputError(ctx.input, DECLARED_INPUTS);
    if (undeclared) return { success: false, error: undeclared };

    const { calendarId, title, start, end, description, location, attendees, conferencing, recurrence } = ctx.input as {
      calendarId?: string;
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      attendees?: unknown;
      conferencing?: unknown;
      recurrence?: unknown;
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
    let parsedAttendees: CreateEventInput['attendees'];
    if (attendees !== undefined) {
      const parsed = parseWritableAttendees(attendees);
      if (!parsed.ok) return { success: false, error: parsed.error };
      parsedAttendees = parsed.attendees;
    }
    let parsedRecurrence: string[] | undefined;
    if (recurrence !== undefined) {
      // A series needs a named timezone so occurrences keep their wall-clock time across DST.
      if (!ctx.timezone) {
        return { success: false, error: 'Cannot create a recurring event: no timezone is configured for Curia' };
      }
      const parsed = parseRecurrence(recurrence, { start, timezone: ctx.timezone });
      if (!parsed.ok) return { success: false, error: parsed.error };
      parsedRecurrence = parsed.recurrence;
    }
    let parsedConferencing: CreateEventInput['conferencing'];
    // null is an omitted optional here: a new event simply has no conferencing.
    if (conferencing !== undefined && conferencing !== null) {
      const parsed = parseConferencing(conferencing);
      if (!parsed.ok) return { success: false, error: parsed.error };
      parsedConferencing = parsed.conferencing;
    }

    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };

    try {
      // The mailbox the calendar belongs to (#2475); `primary` becomes its home calendar's ID.
      // With several mailboxes, an event on the principal's calendar needs a stated mailbox (it is
      // the account the invitation comes from), and that mailbox must own the calendar (D5).
      const gate = await gateCalendarWrite(ctx, TOOL, calendarId, mailbox.mailbox, { requireMailbox: true });
      if (gate.kind === 'error') return { success: false, error: gate.error };
      const attendeeAddresses = (parsedAttendees ?? []).map((a) => a.email);
      if (gate.kind === 'needs_mailbox') {
        return needsMailboxResult(ctx, TOOL, gate.mailboxes, evidenceRecipients(attendeeAddresses, gate.live));
      }
      const { client, calendarId: targetCalendarId, mailboxId } = gate.routed;

      // Read-only check: if the calendar is registered and marked read-only, refuse.
      // Unregistered calendars (null) proceed — Nylas enforces its own permissions.
      // Moved inside try so DB errors from resolveCalendar are caught with skill-level context.
      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(targetCalendarId);
        if (registry?.readOnly) {
          return { success: false, error: 'Calendar is read-only' };
        }
      }

      const eventData: CreateEventInput = { title, start, end };
      if (description) eventData.description = description;
      if (location) eventData.location = location;
      if (parsedAttendees) eventData.attendees = parsedAttendees;
      if (parsedConferencing) eventData.conferencing = parsedConferencing;
      if (parsedRecurrence) {
        eventData.recurrence = parsedRecurrence;
        eventData.timezone = ctx.timezone;
      }

      const event = await client.createEvent(targetCalendarId, eventData);
      ctx.log.info({ eventId: event.id, mailboxId }, 'Created calendar event');

      // Self-release: a real booking supersedes any tentative holds we placed on the
      // same slot. List overlapping events and delete only our own curia-hold events.
      // Failure here must never fail the booking — the event is already created.
      // The outer try/catch guards listEvents; the inner per-event try/catch ensures
      // one failing deleteEvent doesn't abort the rest of the loop.
      const warnings: string[] = [];
      // With several mailboxes a hold for this slot may sit on another account's home calendar
      // (D7): every live home calendar is searched. With one mailbox, only this calendar, as before.
      const release = await holdReleaseTargets(ctx, TOOL, gate.routed, gate.multi && gate.principal);
      warnings.push(...release.warnings);
      const startUnix = Math.floor(new Date(start).getTime() / 1000);
      const endUnix = Math.floor(new Date(end).getTime() / 1000);
      for (const target of release.targets) {
        try {
          const overlapping = await target.client.listEvents(target.calendarId, start, end);
          for (const e of overlapping) {
            if (e.id === event.id) continue;           // skip the event we just created
            if (!isHoldEvent(e)) continue;             // skip real (non-hold) events
            if (e.startTime === null || e.endTime === null) continue;  // skip malformed holds
            if (!eventsOverlap(startUnix, endUnix, e.startTime, e.endTime)) continue; // skip non-overlapping
            if (holdHasAttendees(e)) {
              // Deleting would email its attendees a cancellation; leave it for a person,
              // and say so in the result so the caller doesn't report the slot as clean.
              warnings.push(`Hold ${e.id} overlaps this booking but has attendees, so it was left in place to avoid emailing them a cancellation.`);
              ctx.log.warn({ holdId: e.id, bookedEventId: event.id, mailboxId: target.mailboxId }, 'calendar-create-event: overlapping hold has attendees, not releasing');
              continue;
            }
            // Per-event try/catch: one failing delete must not abort the rest of the loop.
            // A transient Nylas error on one hold should not prevent releasing the others.
            try {
              await target.client.deleteEvent(target.calendarId, e.id); // no notify flag: no attendees to email, and Microsoft rejects false
              ctx.log.info({ releasedHoldId: e.id, bookedEventId: event.id, mailboxId: target.mailboxId }, 'calendar-create-event: released overlapping hold');
            } catch (err) {
              ctx.log.warn({ ...grantSafeErrorFields(err), holdId: e.id, bookedEventId: event.id, mailboxId: target.mailboxId }, 'calendar-create-event: failed to release overlapping hold, continuing');
              // In the result too (SF-M4), as respond-to-invite does: the slot is not clean.
              warnings.push(`Hold ${e.id} overlaps this booking but could not be removed; it is still on the calendar.`);
            }
          }
        } catch (err) {
          // One calendar's listing failing must not stop the search of the others.
          ctx.log.warn({ ...grantSafeErrorFields(err), bookedEventId: event.id, mailboxId: target.mailboxId }, 'calendar-create-event: hold self-release failed (booking unaffected)');
          const label = gate.live.find((m) => m.id === target.mailboxId)?.label ?? target.mailboxId;
          warnings.push(`Holds on the "${label}" mailbox's calendar were not checked for this slot: listing them failed.`);
        }
      }

      // With several mailboxes the result names the account and how the attendee evidence
      // bears on it (D5), so the agent can tell an obvious choice from one worth mentioning.
      let account: Record<string, unknown> = {};
      if (gate.multi) {
        const chosen = gate.live.find((m) => m.id === mailboxId);
        account = { mailbox: mailboxId, mailbox_label: chosen?.label ?? null };
        const recipients = evidenceRecipients(attendeeAddresses, gate.live);
        if (recipients.length > 0) account = { ...account, ...(await evidenceVerdict(ctx, TOOL, mailboxId, recipients)) };
      }

      // Format timestamps in the user's local timezone so the confirmation matches
      // what calendar-list-events returns. toLocalIso handles null/invalid values internally.
      const tz = ctx.timezone;
      return {
        success: true,
        data: {
          event: localizeEventTimes(event, tz),
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
          ...account,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...grantSafeErrorFields(err) }, 'Failed to create event');
      return { success: false, error: `Failed to create event: ${message}` };
    }
  }
}
