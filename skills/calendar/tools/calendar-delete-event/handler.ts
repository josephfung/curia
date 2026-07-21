// skills/calendar-delete-event/handler.ts
//
// Deletes a calendar event. Checks read-only flag before attempting deletion.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

export class CalendarDeleteEventHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.nylasCalendarClient) {
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

    try {
      // Read-only check — moved inside try so DB errors from resolveCalendar are caught with skill-level context.
      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(calendarId);
        if (registry?.readOnly) {
          return { success: false, error: 'Calendar is read-only' };
        }
      }

      await ctx.nylasCalendarClient.deleteEvent(calendarId, eventId, notifyAttendees);
      ctx.log.info({ calendarId, eventId }, 'Deleted calendar event');
      return { success: true, data: { deleted: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId, eventId }, 'Failed to delete event');
      return { success: false, error: `Failed to delete event: ${message}` };
    }
  }
}
