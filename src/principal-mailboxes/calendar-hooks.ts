// Calendar side of adding and removing a principal mailbox (#2475, D7).
//
// - Adding a mailbox registers that grant's Nylas primary calendar (by its real ID, never the
//   alias `primary`) to the principal's contact as `is_primary` for that mailbox: its home
//   calendar. A row for that calendar under another mailbox is moved to the new one (the owning
//   grant wins).
// - Removing a mailbox leaves its calendars' rows pointing at the tombstoned mailbox. That is
//   what marks them disconnected: the calendar router refuses them (`mailbox_removed`) and lists
//   them as removed, never routes them through another grant.
//
// Logs carry mailbox ids and counts only: never grant ids, addresses or calendar IDs.
import type { Logger } from '../logger.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { NylasCalendarClient } from '../channels/calendar/nylas-calendar-client.js';

export type HomeCalendarOutcome = 'registered' | 'moved' | 'already_registered' | 'no_primary_calendar';

export interface MailboxCalendarHooks {
  /** Register the mailbox's home calendar. Throws on a Nylas or database failure. */
  registerHome(mailboxId: string, mailboxLabel: string): Promise<HomeCalendarOutcome>;
  /** Calendars registered through the mailbox (any contact), for the removal preview. */
  listForMailbox(mailboxId: string): Promise<Array<{ calendarId: string; label: string }>>;
  /** onRemoved hook: records that the mailbox's calendars are disconnected. */
  onRemoved(mailboxId: string): Promise<void>;
}

export interface MailboxCalendarHooksDeps {
  contacts: Pick<ContactService, 'resolveCalendar' | 'linkCalendar' | 'setCalendarMailbox' | 'getCalendarsForMailbox'>;
  principalContactId: string;
  /** The live mailbox's calendar client (PrincipalMailboxes.calendarClient). */
  calendarClient: (mailboxId: string) => Promise<Pick<NylasCalendarClient, 'listCalendars'>>;
  logger: Logger;
}

export function createMailboxCalendarHooks(deps: MailboxCalendarHooksDeps): MailboxCalendarHooks {
  const log = deps.logger.child({ component: 'mailbox-calendars' });
  return {
    async registerHome(mailboxId, mailboxLabel) {
      const client = await deps.calendarClient(mailboxId);
      const primary = (await client.listCalendars()).find((c) => c.isPrimary);
      if (!primary) {
        log.warn({ mailboxId }, 'The new mailbox lists no primary calendar; no home calendar registered');
        return 'no_primary_calendar';
      }
      const existing = await deps.contacts.resolveCalendar(primary.id);
      if (!existing) {
        await deps.contacts.linkCalendar({
          nylasCalendarId: primary.id,
          contactId: deps.principalContactId,
          label: mailboxLabel,
          isPrimary: true,
          principalMailboxId: mailboxId,
        });
        log.info({ mailboxId }, 'Registered the mailbox home calendar');
        return 'registered';
      }
      if (existing.principalMailboxId === mailboxId) return 'already_registered';
      // Registered through another mailbox it was shared into: the owning grant wins.
      await deps.contacts.setCalendarMailbox(primary.id, mailboxId);
      if (existing.contactId !== deps.principalContactId || !existing.isPrimary) {
        log.warn(
          { mailboxId, principalOwned: existing.contactId === deps.principalContactId, isPrimary: existing.isPrimary },
          "The mailbox's home calendar was already registered, not as the principal's primary; moved to the mailbox as it is",
        );
      } else {
        log.info({ mailboxId, fromMailboxId: existing.principalMailboxId }, 'Moved the home calendar to the mailbox that owns it');
      }
      return 'moved';
    },

    async listForMailbox(mailboxId) {
      return (await deps.contacts.getCalendarsForMailbox(mailboxId)).map((c) => ({ calendarId: c.nylasCalendarId, label: c.label }));
    },

    async onRemoved(mailboxId) {
      const count = (await deps.contacts.getCalendarsForMailbox(mailboxId)).length;
      if (count > 0) log.info({ mailboxId, count }, 'Calendars of a removed mailbox are disconnected');
    },
  };
}
