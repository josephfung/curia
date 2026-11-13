// skills/calendar-delete-event/handler.ts
//
// Deletes a calendar event. Checks read-only flag before attempting deletion.
// Goes through the mailbox the calendar belongs to (#2475).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { isNylasBadRequest } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import { gateCalendarWrite, readCalendarMailbox } from '../../../_shared/calendar-route.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';

export class CalendarDeleteEventHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.calendarRouter) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarId, eventId, notifyAttendees } = ctx.input as {
      calendarId?: string;
      eventId?: string;
      notifyAttendees?: boolean;
    };

    if (!calendarId || typeof calendarId !== 'string') {
      return { success: false, error: 'Missing required input: calendarId' };
    }
    if (!eventId || typeof eventId !== 'string') {
      return { success: false, error: 'Missing required input: eventId' };
    }
    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };

    try {
      // A stated mailbox that does not own the calendar is refused (calendar_mailbox_mismatch),
      // never quietly overridden, so the agent never names the wrong account (SF-M1).
      const gate = await gateCalendarWrite(ctx, 'calendar-delete-event', calendarId, mailbox.mailbox, { requireMailbox: false });
      if (gate.kind !== 'proceed') return { success: false, error: gate.kind === 'error' ? gate.error : 'needs_mailbox' };
      const { client, calendarId: target, mailboxId } = gate.routed;

      // Read-only check — moved inside try so DB errors from resolveCalendar are caught with skill-level context.
      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(target);
        if (registry?.readOnly) {
          return { success: false, error: 'Calendar is read-only' };
        }
      }

      await client.deleteEvent(target, eventId, notifyAttendees);
      ctx.log.info({ eventId, mailboxId }, 'Deleted calendar event');
      return { success: true, data: { deleted: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...grantSafeErrorFields(err), eventId }, 'Failed to delete event');
      // Microsoft rejects notify_participants=false with a 400. Say so, rather than
      // let the agent retry silently or drop the flag and email attendees unasked.
      // Only a 400 proves nothing changed; a timeout or 5xx leaves the outcome unknown.
      const hint = notifyAttendees === false && isNylasBadRequest(err)
        ? ' Microsoft calendars reject notifyAttendees=false. The event was not deleted; ask the principal before retrying with attendees notified.'
        : '';
      return { success: false, error: `Failed to delete event: ${message}${hint}` };
    }
  }
}
