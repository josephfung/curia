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
// mailbox is live.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { ContactCalendar } from '../../../../src/contacts/calendar-types.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';
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
            error: `Contact ${resolvedContactId ?? '(none)'} already has a primary calendar for this mailbox. Set is_primary to false, or unregister the existing primary calendar first.`,
          };
        }
        return this.alreadyRegistered(ctx, nylas_calendar_id, placement);
      }

      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contactId: resolvedContactId }, 'Failed to register calendar');
      return { success: false, error: `Failed to register calendar: ${message}` };
    }
  }

  /**
   * The calendar is registered already. When the owning grant decided this registration and the
   * row names another mailbox, the row is moved to the owner (D7); otherwise it stays, and the
   * error says which mailbox it is registered through.
   */
  private async alreadyRegistered(
    ctx: ToolContext,
    nylasCalendarId: string,
    placement: { mailboxId: string | null; owner: boolean },
  ): Promise<ToolResult> {
    const contacts = ctx.contactService!;
    try {
      const existing = await contacts.resolveCalendar(nylasCalendarId);
      if (placement.owner && placement.mailboxId !== null && existing && existing.principalMailboxId !== placement.mailboxId) {
        await contacts.setCalendarMailbox(nylasCalendarId, placement.mailboxId);
        ctx.log.info(
          { fromMailboxId: existing.principalMailboxId, mailboxId: placement.mailboxId },
          'calendar-register: moved a calendar to the mailbox that owns it',
        );
        return {
          success: true,
          data: {
            nylas_calendar_id: nylasCalendarId,
            contact_id: existing.contactId,
            label: existing.label,
            is_primary: existing.isPrimary,
            mailbox: placement.mailboxId,
            moved_from_mailbox: existing.principalMailboxId,
          },
        };
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
        ctx.log.warn({ mailboxId: placement.mailboxId }, 'calendar-register: the owning mailbox already has a primary for this contact');
        return {
          success: false,
          error: `Calendar ${nylasCalendarId} belongs to the "${placement.mailboxId}" mailbox, which already has a primary calendar for that contact; unregister one first.`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'calendar-register: could not check or move the existing registration');
      return { success: false, error: `Failed to register calendar: ${message}` };
    }
  }
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
