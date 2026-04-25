// skills/calendar-register/handler.ts
//
// Registers a Nylas calendar in the contact registry by linking it to a contact.
//
// The typical flow is:
//   1. calendar-list-calendars surfaces an unregistered calendar
//   2. The CEO confirms which contact owns it (usually themselves)
//   3. This skill persists that mapping so calendar-list-events can auto-resolve it
//
// contact_id is required — the coordinator must always specify which contact
// owns the calendar. This prevents silent mis-assignment (see incident
// kg-web-a7717246-1d7a-411c-9129-b6feb54bfc22).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class CalendarRegisterHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.contactService) {
      return { success: false, error: 'calendar-register: contactService not available — this is a universal service, check ExecutionLayer configuration.' };
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

    // contact_id is required — the coordinator must explicitly specify which
    // contact owns this calendar. This prevents silent mis-assignment when the
    // caller (e.g. the CEO) is not the calendar's actual owner.
    if (!contact_id || typeof contact_id !== 'string' || contact_id.trim() === '') {
      return { success: false, error: 'Missing required input: contact_id — specify which contact owns this calendar.' };
    }

    const resolvedContactId = contact_id.trim();

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
      // Postgres unique_violation (code 23505): translate raw constraint names into
      // human-readable messages so the LLM can give the CEO actionable feedback.
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '23505') {
        const constraint = (err as { constraint?: string }).constraint ?? '';
        if (constraint.includes('primary')) {
          ctx.log.warn(
            { nylasCalendarId: nylas_calendar_id, contactId: resolvedContactId },
            'calendar-register: contact already has a primary calendar',
          );
          return {
            success: false,
            error: `Contact ${resolvedContactId ?? '(none)'} already has a primary calendar. Set is_primary to false, or unregister the existing primary calendar first.`,
          };
        }
        ctx.log.warn(
          { nylasCalendarId: nylas_calendar_id, contactId: resolvedContactId },
          'calendar-register: calendar already registered',
        );
        return {
          success: false,
          error: `Calendar ${nylas_calendar_id} is already registered. Use calendar-list-calendars to see its current mapping.`,
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, nylasCalendarId: nylas_calendar_id, contactId: resolvedContactId }, 'Failed to register calendar');
      return { success: false, error: `Failed to register calendar: ${message}` };
    }
  }
}
