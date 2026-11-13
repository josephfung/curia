// skills/calendar-register/handler.ts
//
// Registers a Nylas calendar in the contact registry by linking it to a contact.
//
// The typical flow is:
//   1. calendar-list-calendars surfaces an unregistered calendar
//   2. The principal confirms which contact owns it (usually themselves)
//   3. This skill persists that mapping so calendar-list-events can auto-resolve it
//
// contact_id is required — the coordinator must always specify which contact
// owns the calendar. This prevents silent mis-assignment (see incident
// kg-web-a7717246-1d7a-411c-9129-b6feb54bfc22).
//
// Every registration names the principal mailbox the calendar is read and written through
// (#2475, D7). The owning grant wins: a calendar ID equal to a live mailbox's address is that
// account's own calendar and is registered to that mailbox, and an existing row naming another
// mailbox is rewritten to it. Otherwise `mailbox` decides, and it is required once more than one
// mailbox is live. An existing row with no mailbox, or one whose mailbox was removed, is moved to
// the requested mailbox (R77); a row under another live mailbox is refused.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { ContactCalendar } from '../../../../src/contacts/calendar-types.js';
import { grantSafeErrorFields, mayCarryGrantId } from '../../../../src/principal-mailboxes/error-fields.js';
import { CalendarRouteError, PRIMARY_CALENDAR_ALIAS } from '../../../../src/channels/calendar/calendar-router.js';
import { calendarRouteErrorMessage, readCalendarMailbox } from '../../../_shared/calendar-route.js';

export class CalendarRegisterHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.contactService) {
      return { success: false, error: 'calendar-register: contactService not available — this is a universal service, check ExecutionLayer configuration.' };
    }
    if (!ctx.calendarRouter) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
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
    if (nylas_calendar_id === PRIMARY_CALENDAR_ALIAS) {
      // The alias names a different calendar per grant; only real IDs are stored (D7).
      return { success: false, error: 'Register a calendar by its real ID, not "primary" (calendar-list-calendars shows it).' };
    }
    if (!label || typeof label !== 'string') {
      return { success: false, error: 'Missing required input: label' };
    }
    if (label.length > 200) {
      return { success: false, error: 'label must be 200 characters or fewer' };
    }

    // contact_id is required — the coordinator must explicitly specify which
    // contact owns this calendar. This prevents silent mis-assignment when the
    // caller (e.g. the principal) is not the calendar's actual owner.
    if (!contact_id || typeof contact_id !== 'string' || contact_id.trim() === '') {
      return { success: false, error: 'Missing required input: contact_id — specify which contact owns this calendar.' };
    }
    const mailboxInput = readCalendarMailbox(ctx.input);
    if (!mailboxInput.ok) return { success: false, error: mailboxInput.error };

    const resolvedContactId = contact_id.trim();

    let placement: { mailboxId: string | null; owner: boolean };
    try {
      placement = await ctx.calendarRouter.registrationMailbox(nylas_calendar_id, mailboxInput.mailbox);
    } catch (err) {
      if (err instanceof CalendarRouteError) {
        ctx.log.warn({ code: err.code }, 'calendar-register: no mailbox for the calendar');
      } else {
        ctx.log.error({ ...grantSafeErrorFields(err) }, 'calendar-register: could not choose the mailbox');
      }
      return { success: false, error: calendarRouteErrorMessage(err) };
    }

    // One of the principal's calendars decides routing and is read as their events, so it must be
    // one the mailbox's account can see (SEC-L5): an arbitrary id (someone's public calendar) is
    // refused. Other contacts' calendars are read as free/busy, which needs no visibility.
    if (resolvedContactId === ctx.calendarRouter.principalContactId && placement.mailboxId !== null && !placement.owner) {
      const visible = await this.visibleToMailbox(ctx, nylas_calendar_id, placement.mailboxId);
      if (visible !== true) return { success: false, error: visible };
    }

    ctx.log.info(
      { contactId: resolvedContactId, label, isPrimary: is_primary ?? false, mailboxId: placement.mailboxId, owner: placement.owner },
      'Registering calendar',
    );

    try {
      const calendar = await ctx.contactService.linkCalendar({
        nylasCalendarId: nylas_calendar_id,
        contactId: resolvedContactId,
        label,
        isPrimary: is_primary ?? false,
        principalMailboxId: placement.mailboxId,
      });

      ctx.log.info(
        { calendarId: calendar.id, contactId: calendar.contactId, mailboxId: calendar.principalMailboxId },
        'Calendar registered successfully',
      );

      return { success: true, data: registered(calendar) };
    } catch (err) {
      // Postgres unique_violation (code 23505): translate raw constraint names into
      // human-readable messages so the LLM can give the principal actionable feedback.
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '23505') {
        const constraint = (err as { constraint?: string }).constraint ?? '';
        if (constraint.includes('primary')) {
          ctx.log.warn(
            { contactId: resolvedContactId, mailboxId: placement.mailboxId },
            'calendar-register: contact already has a primary calendar',
          );
          return {
            success: false,
            error:
              `Contact ${resolvedContactId ?? '(none)'} already has a primary calendar for this mailbox. Register this one with is_primary false. ` +
              'No tool unregisters a calendar: to make this one the primary instead, tell the principal an operator must change the registry.',
          };
        }
        return this.alreadyRegistered(ctx, nylas_calendar_id, placement, { contactId: resolvedContactId, label, isPrimary: is_primary ?? false });
      }

      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...safeErrFields(err), contactId: resolvedContactId }, 'Failed to register calendar');
      return { success: false, error: `Failed to register calendar: ${message}` };
    }
  }

  /**
   * True when the mailbox's account lists this calendar, else the error to return. A listing that
   * fails refuses too (nothing is registered): the check is what keeps an arbitrary id out.
   */
  private async visibleToMailbox(ctx: ToolContext, calendarId: string, mailboxId: string): Promise<true | string> {
    try {
      const client = await ctx.calendarRouter!.clientFor(mailboxId);
      const id = calendarId.trim().toLowerCase();
      if ((await client.listCalendars()).some((c) => c.id.trim().toLowerCase() === id)) return true;
      ctx.log.warn({ mailboxId }, 'calendar-register: the calendar is not visible to the mailbox\'s account; refused');
      return (
        `Calendar ${calendarId} is not one the "${mailboxId}" mailbox's account can see, so it was not registered as the principal's calendar. ` +
        'Use an id from calendar-list-calendars, with the mailbox it lists.'
      );
    } catch (err) {
      ctx.log.warn({ mailboxId, ...safeErrFields(err) }, 'calendar-register: could not list the mailbox\'s calendars; refused');
      return `Could not check the calendar against the "${mailboxId}" mailbox's account, so nothing was registered: ${calendarRouteErrorMessage(err)}`;
    }
  }

  /**
   * The calendar is registered already. The row moves to the placement's mailbox when
   * - the owning grant decided the placement (D7, R74: the owner wins even over a live mailbox), or
   * - the row has no mailbox, or names a removed one (R77: the way back after an account swap).
   * A row under another live mailbox stays where it is, and the error names that mailbox.
   * A move changes only the mailbox: contact, label and primary flag stay as registered, and
   * the result says so (`updated: ['mailbox']`, plus the requested fields it did not apply).
   */
  private async alreadyRegistered(
    ctx: ToolContext,
    nylasCalendarId: string,
    placement: { mailboxId: string | null; owner: boolean },
    requested: { contactId: string; label: string; isPrimary: boolean },
  ): Promise<ToolResult> {
    const contacts = ctx.contactService!;
    const router = ctx.calendarRouter!;
    try {
      const existing = await contacts.resolveCalendar(nylasCalendarId);
      const target = placement.mailboxId;
      if (existing && target !== null && existing.principalMailboxId !== target) {
        const from = existing.principalMailboxId;
        const movable = placement.owner || from === null || !(await router.isLive(from));
        if (movable) {
          await contacts.setCalendarMailbox(nylasCalendarId, target);
          ctx.log.info(
            { fromMailboxId: from, mailboxId: target, owner: placement.owner },
            'calendar-register: moved an existing calendar registration to another mailbox',
          );
          const row = (await contacts.getCalendarsForMailbox(target)).find((c) => c.nylasCalendarId === nylasCalendarId);
          const notApplied = [
            ...(existing.contactId !== requested.contactId ? ['contact_id'] : []),
            ...(existing.label !== requested.label ? ['label'] : []),
            ...(existing.isPrimary !== requested.isPrimary ? ['is_primary'] : []),
          ];
          return {
            success: true,
            data: {
              calendar_id: row?.id ?? null,
              nylas_calendar_id: nylasCalendarId,
              contact_id: existing.contactId,
              label: existing.label,
              is_primary: existing.isPrimary,
              mailbox: target,
              moved_from_mailbox: from,
              updated: ['mailbox'],
              ...(notApplied.length > 0
                ? {
                    not_applied: notApplied,
                    note:
                      `It was already registered, so only its mailbox changed; ${notApplied.join(', ')} kept the registered values. ` +
                      'No tool unregisters a calendar: changing them needs an operator, so tell the principal if it matters.',
                  }
                : {}),
            },
          };
        }
      }
      ctx.log.warn({ mailboxId: existing?.principalMailboxId ?? null }, 'calendar-register: calendar already registered');
      const through = existing?.principalMailboxId ? ` through the "${existing.principalMailboxId}" mailbox` : '';
      return {
        success: false,
        error: `Calendar ${nylasCalendarId} is already registered${through}. Use calendar-list-calendars to see its current mapping.`,
      };
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '23505') {
        // Moving a primary calendar into a mailbox where its contact already has one.
        ctx.log.warn({ mailboxId: placement.mailboxId }, 'calendar-register: the target mailbox already has a primary for this contact');
        return {
          success: false,
          error:
            `Calendar ${nylasCalendarId} cannot move to the "${placement.mailboxId}" mailbox, which already has a primary calendar for that contact. ` +
            'No tool unregisters a calendar: tell the principal an operator must change the registry.',
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...safeErrFields(err) }, 'calendar-register: could not check or move the existing registration');
      return { success: false, error: `Failed to register calendar: ${message}` };
    }
  }
}

/** Grant-safe log fields: the class and status, plus the message only when it cannot echo a grant (SEC-L6). */
function safeErrFields(err: unknown): Record<string, unknown> {
  return { ...grantSafeErrorFields(err), ...(err instanceof Error && !mayCarryGrantId(err) ? { errMessage: err.message } : {}) };
}

function registered(calendar: ContactCalendar): Record<string, unknown> {
  return {
    calendar_id: calendar.id,
    nylas_calendar_id: calendar.nylasCalendarId,
    contact_id: calendar.contactId,
    label: calendar.label,
    is_primary: calendar.isPrimary,
    mailbox: calendar.principalMailboxId,
  };
}
