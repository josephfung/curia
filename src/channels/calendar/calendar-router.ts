// CalendarRouter — every calendar call goes through the mailbox the calendar belongs to (#2475, D7).
//
// A calendar is read and written through one principal mailbox's Nylas grant: the one its
// contact_calendars row names. Google calendar IDs are not grant-scoped (a shared calendar
// answers in every grant), so a 404 cannot pick the account; the registry does.
//
// - The owning grant wins: a calendar ID equal to a live mailbox's address is that account's
//   own calendar and always goes through that mailbox, whatever its registry row says.
// - Otherwise a registered calendar routes to its row's mailbox. A row whose mailbox was
//   removed is an error (`mailbox_removed`), never a fallback to another mailbox.
// - Anything else needs `mailbox` once more than one mailbox is live (`needs_mailbox`). With
//   exactly one live mailbox it goes through that one, as before Part 4.
// - The literal `primary` (Nylas's alias) is never sent unscoped: it is rewritten to the chosen
//   mailbox's home calendar ID, and with several mailboxes and no `mailbox` it is refused
//   (`primary_alias_needs_mailbox`).
//
// Logs carry mailbox ids, codes and counts only: never grant ids, addresses or calendar IDs
// (a Google calendar ID is usually an address).
import type { Logger } from '../../logger.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { CalendarRouterMailboxes, PrincipalMailboxView } from '../../principal-mailboxes/service.js';
import { RemovedMailboxError, UnknownMailboxError } from '../../principal-mailboxes/types.js';
import type { NylasCalendarClient } from './nylas-calendar-client.js';

/** Nylas's alias for a grant's primary calendar. Never stored, never sent without a mailbox. */
export const PRIMARY_CALENDAR_ALIAS = 'primary';

export interface RoutedCalendar {
  mailboxId: string;
  /** The calendar ID to send: the input, or the home calendar's real ID for `primary`. */
  calendarId: string;
  client: NylasCalendarClient;
}

/** A mailbox's home (primary) calendar. A removed mailbox's has no client: its grant is gone. */
export type HomeCalendar =
  | (RoutedCalendar & { label: string; removed: false })
  | { mailboxId: string; calendarId: string; client: null; label: string; removed: true };

export type CalendarRouteErrorCode =
  | 'needs_mailbox'
  | 'primary_alias_needs_mailbox'
  | 'mailbox_removed'
  | 'unknown_mailbox'
  /** No principal mailbox is connected at all. */
  | 'no_mailbox'
  /** The mailbox's grant has no primary calendar to stand for `primary`. */
  | 'no_home_calendar';

/** A calendar call that cannot be routed. The message says what to pass; it never names a grant. */
export class CalendarRouteError extends Error {
  constructor(
    readonly code: CalendarRouteErrorCode,
    message: string,
    /** The live mailboxes the caller can choose from (needs_mailbox, primary_alias_needs_mailbox). */
    readonly mailboxes: Array<{ id: string; label: string }> = [],
  ) {
    super(message);
    this.name = 'CalendarRouteError';
  }
}

export interface CalendarRouterDeps {
  mailboxes: CalendarRouterMailboxes;
  contacts: Pick<ContactService, 'resolveCalendar' | 'getCalendarsForContact' | 'getPrimaryCalendar'>;
  principalContactId: string;
  logger: Logger;
}

const lower = (s: string): string => s.trim().toLowerCase();

function choices(live: PrincipalMailboxView[]): string {
  return live.map((m) => `${m.id} (${m.label})`).join(', ');
}

export class CalendarRouter {
  private readonly log: Logger;

  constructor(private readonly deps: CalendarRouterDeps) {
    this.log = deps.logger.child({ component: 'calendar-router' });
  }

  /** The live principal mailboxes (the deferred-migration fallback included). */
  async liveMailboxes(): Promise<PrincipalMailboxView[]> {
    return this.deps.mailboxes.list();
  }

  /** A live mailbox by id; unknown and removed ids are CalendarRouteErrors. */
  async mailbox(id: string): Promise<PrincipalMailboxView> {
    try {
      return await this.deps.mailboxes.get(id);
    } catch (err) {
      if (err instanceof RemovedMailboxError) {
        throw new CalendarRouteError('mailbox_removed', `Mailbox "${id}" (${err.label}) has been removed; its calendars can no longer be read or written.`);
      }
      if (err instanceof UnknownMailboxError) {
        const live = await this.deps.mailboxes.list();
        throw new CalendarRouteError(
          'unknown_mailbox',
          live.length > 0 ? `Unknown mailbox "${id}"; pass one of: ${choices(live)}.` : `Unknown mailbox "${id}"; no principal mailbox is connected.`,
          live.map(({ id: mid, label }) => ({ id: mid, label })),
        );
      }
      throw err;
    }
  }

  /** The calendar client of one live mailbox. */
  async clientFor(mailboxId: string): Promise<NylasCalendarClient> {
    await this.mailbox(mailboxId);
    return this.deps.mailboxes.calendarClient(mailboxId);
  }

  /**
   * The mailbox and client a calendar call goes through. `mailboxHint` is the tool's `mailbox`
   * input: always validated, used for `primary` and for calendars no registry row places.
   * A registered calendar goes through its row's mailbox whatever the hint says.
   */
  async route(calendarId: string, mailboxHint?: string): Promise<RoutedCalendar> {
    const hinted = mailboxHint !== undefined ? await this.mailbox(mailboxHint) : undefined;

    if (calendarId === PRIMARY_CALENDAR_ALIAS) {
      const mb = hinted ?? (await this.soleMailbox('primary_alias_needs_mailbox', calendarId));
      const client = await this.deps.mailboxes.calendarClient(mb.id);
      return { mailboxId: mb.id, calendarId: await this.homeCalendarId(mb.id, client), client };
    }

    // The owning grant wins over a registry row too: a row written before the rule (or by the
    // backfill) can name another mailbox the calendar is merely shared into.
    const owner = await this.owner(calendarId);
    if (owner) return { mailboxId: owner.id, calendarId, client: await this.deps.mailboxes.calendarClient(owner.id) };

    const row = await this.deps.contacts.resolveCalendar(calendarId);
    if (row?.principalMailboxId) {
      const mb = await this.mailbox(row.principalMailboxId);
      if (hinted && hinted.id !== mb.id) {
        this.log.debug({ mailboxId: mb.id, hintedMailboxId: hinted.id }, 'Registered calendar routed to its own mailbox, not the hint');
      }
      return { mailboxId: mb.id, calendarId, client: await this.deps.mailboxes.calendarClient(mb.id) };
    }

    // Not placed by the registry (unregistered, or a row the boot backfill has not assigned).
    const mb = hinted ?? (await this.soleMailbox('needs_mailbox', calendarId));
    return { mailboxId: mb.id, calendarId, client: await this.deps.mailboxes.calendarClient(mb.id) };
  }

  /**
   * The mailbox a new registration belongs to: the owner (a live mailbox whose address is the
   * calendar ID), else the hint, else the sole live mailbox. `owner` says the owning-grant rule
   * decided it. `mailboxId` is null while the deferred-migration fallback is served: the
   * fallback has no registry row to reference, and the boot backfill assigns the default later.
   */
  async registrationMailbox(calendarId: string, mailboxHint?: string): Promise<{ mailboxId: string | null; owner: boolean }> {
    const hinted = mailboxHint !== undefined ? await this.mailbox(mailboxHint) : undefined;
    if (await this.deps.mailboxes.isFallbackActive()) return { mailboxId: null, owner: false };
    const owner = await this.owner(calendarId);
    if (owner) return { mailboxId: owner.id, owner: true };
    const mb = hinted ?? (await this.soleMailbox('needs_mailbox', calendarId));
    return { mailboxId: mb.id, owner: false };
  }

  /**
   * Every live mailbox's home calendar, plus the home calendars the registry still holds for
   * removed mailboxes (listed as removed, with no client). A live mailbox whose home calendar
   * cannot be found throws: availability must never skip a calendar silently (D7).
   */
  async homeCalendars(): Promise<HomeCalendar[]> {
    const live = await this.deps.mailboxes.list();
    const out: HomeCalendar[] = [];
    for (const mb of live) {
      const client = await this.deps.mailboxes.calendarClient(mb.id);
      out.push({ mailboxId: mb.id, calendarId: await this.homeCalendarId(mb.id, client), client, label: mb.label, removed: false });
    }
    const liveIds = new Set(live.map((m) => m.id));
    const rows = await this.deps.contacts.getCalendarsForContact(this.deps.principalContactId);
    for (const row of rows) {
      if (!row.isPrimary || !row.principalMailboxId || liveIds.has(row.principalMailboxId)) continue;
      try {
        await this.deps.mailboxes.get(row.principalMailboxId);
      } catch (err) {
        if (err instanceof RemovedMailboxError) {
          out.push({ mailboxId: row.principalMailboxId, calendarId: row.nylasCalendarId, client: null, label: err.label, removed: true });
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  /** The live mailbox whose own address is this calendar ID (that account's calendar), if any. */
  private async owner(calendarId: string): Promise<PrincipalMailboxView | undefined> {
    const id = lower(calendarId);
    if (!id.includes('@')) return undefined;
    return (await this.deps.mailboxes.list()).find((m) => m.address !== '' && lower(m.address) === id);
  }

  /** The one live mailbox, or the error naming the choices when there are several (or none). */
  private async soleMailbox(code: 'needs_mailbox' | 'primary_alias_needs_mailbox', calendarId: string): Promise<PrincipalMailboxView> {
    const live = await this.deps.mailboxes.list();
    if (live.length === 1) return live[0]!;
    if (live.length === 0) throw new CalendarRouteError('no_mailbox', 'No principal mailbox is connected, so there is no calendar to use.');
    this.log.info({ code, liveCount: live.length }, 'Calendar call needs a mailbox');
    const options = live.map(({ id, label }) => ({ id, label }));
    if (code === 'primary_alias_needs_mailbox') {
      throw new CalendarRouteError(code, `"primary" is ambiguous with ${live.length} mailboxes connected; pass mailbox as one of: ${choices(live)}.`, options);
    }
    throw new CalendarRouteError(code, `Calendar "${calendarId}" is not registered to a mailbox; pass mailbox as one of: ${choices(live)}.`, options);
  }

  /**
   * A mailbox's home calendar ID: the principal's primary calendar registered for it, else the
   * grant's own primary calendar as Nylas lists it (its real ID, never the alias).
   */
  private async homeCalendarId(mailboxId: string, client: NylasCalendarClient): Promise<string> {
    const registered = await this.deps.contacts.getPrimaryCalendar(this.deps.principalContactId, mailboxId);
    if (registered) return registered.nylasCalendarId;
    const primary = (await client.listCalendars()).find((c) => c.isPrimary);
    if (!primary) {
      this.log.warn({ mailboxId }, 'Mailbox grant lists no primary calendar');
      throw new CalendarRouteError('no_home_calendar', `Mailbox "${mailboxId}" has no primary calendar; pass a calendar ID instead of "primary".`);
    }
    return primary.id;
  }
}
