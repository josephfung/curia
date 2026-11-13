// skills/calendar-list-calendars/handler.ts
//
// Lists all calendars visible to the principal's Nylas grants, annotated with
// registration status from the contact system calendar registry.
// Unregistered calendars are flagged so the agent can ask the principal
// who they belong to.
//
// Each principal mailbox has its own grant (#2475): every live mailbox is listed, or only the
// one named by `mailbox`. Each calendar says which mailbox it was seen through. A mailbox that
// cannot be listed is reported in `warnings`; the others still answer.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { NylasCalendar } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import type { PrincipalMailboxView } from '../../../../src/principal-mailboxes/service.js';
import { grantSafeErrorFields, mayCarryGrantId } from '../../../../src/principal-mailboxes/error-fields.js';
import { calendarRouteErrorMessage, readCalendarMailbox } from '../../../_shared/calendar-route.js';
import { ADD_PRINCIPAL_MAILBOX_HINT } from '../../../../src/principal-mailboxes/types.js';

export class CalendarListCalendarsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const router = ctx.calendarRouter;
    if (!router) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'calendar-list-calendars: contactService not available — this is a universal service, check ExecutionLayer configuration.' };
    }
    const contactService = ctx.contactService;
    const mailboxInput = readCalendarMailbox(ctx.input);
    if (!mailboxInput.ok) return { success: false, error: mailboxInput.error };

    let mailboxes: PrincipalMailboxView[];
    try {
      mailboxes = mailboxInput.mailbox !== undefined
        ? [await router.mailbox(mailboxInput.mailbox)]
        : await router.liveMailboxes();
    } catch (err) {
      ctx.log.error({ ...grantSafeErrorFields(err) }, 'calendar-list-calendars: could not read the principal mailboxes');
      return { success: false, error: calendarRouteErrorMessage(err) };
    }
    if (mailboxes.length === 0) {
      return { success: false, error: `No principal mailbox is connected, so there are no calendars to list. ${ADD_PRINCIPAL_MAILBOX_HINT}` };
    }

    // Hoisted so the catch block can reference the partial result for log context.
    let listedCount = 0;
    try {
      const perMailbox = await Promise.allSettled(
        mailboxes.map(async (m) => ({ mailbox: m, calendars: await (await router.clientFor(m.id)).listCalendars() })),
      );
      const warnings: string[] = [];
      const listed: Array<{ mailbox: PrincipalMailboxView; cal: NylasCalendar }> = [];
      perMailbox.forEach((r, i) => {
        const m = mailboxes[i]!;
        if (r.status === 'fulfilled') {
          for (const cal of r.value.calendars) listed.push({ mailbox: m, cal });
        } else {
          // Class and status only: a Nylas error can carry the grant id (R20).
          ctx.log.error({ mailboxId: m.id, ...grantSafeErrorFields(r.reason) }, 'Failed to list calendars for a mailbox');
          warnings.push(`Could not list the ${m.label} mailbox's calendars: ${calendarRouteErrorMessage(r.reason)}`);
        }
      });
      // Every mailbox failed: nothing to show. One failing among others is a warning only.
      if (warnings.length === mailboxes.length) {
        return { success: false, error: `Failed to list calendars: ${warnings.join('; ')}` };
      }
      listedCount = listed.length;

      const calendars = await Promise.all(
        listed.map(async ({ mailbox, cal }) => {
          const registry = await contactService.resolveCalendar(cal.id);

          let contactName: string | undefined;
          if (registry?.contactId) {
            const contact = await contactService.getContact(registry.contactId);
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
            // The mailbox it was seen through; a calendar shared into two is listed once per mailbox.
            mailbox: mailbox.id,
            mailbox_label: mailbox.label,
            // The mailbox its registry row names: calls on it go through this one.
            registered_mailbox: registry?.principalMailboxId ?? null,
          };
        }),
      );

      ctx.log.info({ count: calendars.length, mailboxCount: mailboxes.length }, 'Listed calendars');
      return { success: true, data: { calendars, ...(warnings.length > 0 ? { warnings } : {}) } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Grant-safe (SEC-L6): the class and status, plus the message only when it cannot echo a grant.
      ctx.log.error({ ...grantSafeErrorFields(err), ...(err instanceof Error && !mayCarryGrantId(err) ? { errMessage: err.message } : {}), calendarCount: listedCount }, 'Failed to list calendars');
      return { success: false, error: `Failed to list calendars: ${message}` };
    }
  }
}
