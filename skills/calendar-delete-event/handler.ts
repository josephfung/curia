// skills/calendar-delete-event/handler.ts
//
// Deletes a calendar event. Checks read-only flag before attempting deletion.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class CalendarDeleteEventHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarId, eventId } = ctx.input as {
      calendarId?: string;
      eventId?: string;
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

      await ctx.nylasCalendarClient.deleteEvent(calendarId, eventId);
      ctx.log.info({ calendarId, eventId }, 'Deleted calendar event');
      return { success: true, data: { deleted: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId, eventId }, 'Failed to delete event');
      return { success: false, error: `Failed to delete event: ${message}` };
    }
  }
}
