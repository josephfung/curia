// skills/calendar-register/handler.ts
//
// Registers a Nylas calendar in the contact registry by linking it to a contact.
//
// The typical flow is:
//   1. calendar-list-calendars surfaces an unregistered calendar
//   2. The CEO confirms which contact owns it (usually themselves)
//   3. This skill persists that mapping so calendar-list-events can auto-resolve it
//
// contact_id defaults to the caller's own contact when omitted — the common case
// when the CEO is claiming ownership of their own calendar.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class CalendarRegisterHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.contactService) {
      return { success: false, error: 'calendar-register requires infrastructure access (contactService)' };
    }

    const { nylas_calendar_id, label, contact_id, is_primary } = ctx.input as {
      nylas_calendar_id?: string;
      label?: string;
      contact_id?: string;
      is_primary?: boolean;
    };

    if (!nylas_calendar_id || typeof nylas_calendar_id !== 'string') {
      return { success: false, error: 'Missing required input: nylas_calendar_id' };
    }
    if (!label || typeof label !== 'string') {
      return { success: false, error: 'Missing required input: label' };
    }
    if (label.length > 200) {
      return { success: false, error: 'label must be 200 characters or fewer' };
    }

    // Default to the caller's contact when contact_id is not provided.
    // This is the most common case: the CEO saying "that calendar is mine."
    const resolvedContactId: string | null =
      typeof contact_id === 'string' ? contact_id : (ctx.caller?.contactId ?? null);

    ctx.log.info(
      { nylasCalendarId: nylas_calendar_id, contactId: resolvedContactId, label, isPrimary: is_primary ?? false },
      'Registering calendar',
    );

    try {
      const calendar = await ctx.contactService.linkCalendar({
        nylasCalendarId: nylas_calendar_id,
        contactId: resolvedContactId,
        label,
        isPrimary: is_primary ?? false,
      });

      ctx.log.info(
        { calendarId: calendar.id, nylasCalendarId: calendar.nylasCalendarId, contactId: calendar.contactId },
        'Calendar registered successfully',
      );

      return {
        success: true,
        data: {
          calendar_id: calendar.id,
          nylas_calendar_id: calendar.nylasCalendarId,
          contact_id: calendar.contactId,
          label: calendar.label,
          is_primary: calendar.isPrimary,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, nylasCalendarId: nylas_calendar_id, contactId: resolvedContactId }, 'Failed to register calendar');
      return { success: false, error: `Failed to register calendar: ${message}` };
    }
  }
}
