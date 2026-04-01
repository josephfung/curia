// skills/calendar-list-calendars/handler.ts
//
// Lists all calendars visible to the Nylas grant, annotated with
// registration status from the contact system calendar registry.
// Unregistered calendars are flagged so the agent can ask the CEO
// who they belong to.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class CalendarListCalendarsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'calendar-list-calendars requires infrastructure access (contactService)' };
    }

    // Hoisted so the catch block can reference the partial result for log context.
    let nylasCalendars: Awaited<ReturnType<typeof ctx.nylasCalendarClient.listCalendars>> | undefined;

    try {
      nylasCalendars = await ctx.nylasCalendarClient.listCalendars();

      const calendars = await Promise.all(
        nylasCalendars.map(async (cal) => {
          const registry = await ctx.contactService!.resolveCalendar(cal.id);

          let contactName: string | undefined;
          if (registry?.contactId) {
            const contact = await ctx.contactService!.getContact(registry.contactId);
            contactName = contact?.displayName;
          }

          return {
            id: cal.id,
            name: cal.name,
            description: cal.description,
            timezone: cal.timezone,
            isPrimary: cal.isPrimary,
            readOnly: cal.readOnly,
            isOwnedByUser: cal.isOwnedByUser,
            registered: registry !== null,
            contactId: registry?.contactId ?? null,
            contactName: contactName ?? null,
            registryLabel: registry?.label ?? null,
          };
        }),
      );

      ctx.log.info({ count: calendars.length }, 'Listed calendars');
      return { success: true, data: { calendars } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarCount: nylasCalendars?.length ?? 'unknown' }, 'Failed to list calendars');
      return { success: false, error: `Failed to list calendars: ${message}` };
    }
  }
}
