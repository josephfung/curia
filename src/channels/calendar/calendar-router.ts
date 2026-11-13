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
import type { CountsOnlyEvidence } from '../../principal-mailboxes/evidence.js';
import { canonicalUuid } from '../../util/uuid.js';

/** Nylas's alias for a grant's primary calendar. Never stored, never sent without a mailbox. */
export const PRIMARY_CALENDAR_ALIAS = 'primary';

export interface RoutedCalendar {
  mailboxId: string;
  /** The calendar ID to send: the input, or the home calendar's real ID for `primary`. */
  calendarId: string;
  client: NylasCalendarClient;
  /**
   * How route() placed the calendar: its owning address, its registry row, the `primary` alias,
   * the caller's `mailbox` hint, or the sole live mailbox. Only `hint` lets the caller choose the
   * account, so only it needs the ownership check (R105). Absent outside route().
   */
  placedBy?: 'owner' | 'registry' | 'primary' | 'hint' | 'sole';
}

export type CalendarRouteErrorCode =
  | 'needs_mailbox'
  | 'primary_alias_needs_mailbox'
  | 'mailbox_removed'
  | 'unknown_mailbox'
  /** No principal mailbox is connected at all. */
  | 'no_mailbox'
  /** The mailbox's grant has no primary calendar to stand for `primary`. */
  | 'no_home_calendar'
  /** Another mailbox's calendars could not be listed, so a hint-placed calendar's owner is unknown (R106). */
  | 'owner_unconfirmed';

/**
 * Whether boot builds the calendar router, and so enrolls the calendar tools (#2475): a Nylas
 * API key and a principal contact (who owns the home calendars). No mailbox is needed: the
 * router reads the registry per call, so one added later works without a restart, and until
 * then each call fails with `no_mailbox`. Shared by production boot and the test-mode stack.
 */
export function calendarRouterEnabled(opts: { hasNylasApiKey: boolean; hasPrincipalContact: boolean }): boolean {
  return opts.hasNylasApiKey && opts.hasPrincipalContact;
}

/** The `no_mailbox` answer: what a calendar tool says while no principal mailbox is connected. */
export const NO_MAILBOX_MESSAGE = 'No principal mailbox is connected, so there is no calendar to use. Add one in the console first.';

/** A calendar call that cannot be routed. The message says what to pass; it never names a grant. */
export class CalendarRouteError extends Error {
  constructor(
    readonly code: CalendarRouteErrorCode,
    message: string,
    /** The live mailboxes the caller can choose from (needs_mailbox, primary_alias_needs_mailbox). */
    readonly mailboxes: Array<{ id: string; label: string }> = [],
    /** mailbox_removed: the removed mailbox, so availability can list its calendar as removed. */
    readonly removedMailbox?: { id: string; label: string },
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

function options(live: PrincipalMailboxView[]): Array<{ id: string; label: string }> {
  return live.map(({ id, label }) => ({ id, label }));
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

  /** The principal's contact id: whose registered calendars are "the principal's calendars". */
  get principalContactId(): string {
    // Canonical (lowercase) form, so a comparison with an id spelled in another case holds.
    return canonicalUuid(this.deps.principalContactId) ?? this.deps.principalContactId.trim();
  }

  /**
   * Per-mailbox history with these attendees (D5). Computed by the mailbox service from each
   * mailbox's mail; one unreadable mailbox is marked, never dropped.
   */
  async evidence(recipients: string[]): Promise<CountsOnlyEvidence[]> {
    return this.deps.mailboxes.evidence(recipients);
  }

  /**
   * True for one of the principal's calendars: the `primary` alias, a live mailbox's own
   * calendar (its address), or a calendar registered to the principal's contact. Writes on these
   * need a stated mailbox once several are live (D5).
   */
  async isPrincipalCalendar(calendarId: string, live?: PrincipalMailboxView[]): Promise<boolean> {
    if (calendarId === PRIMARY_CALENDAR_ALIAS) return true;
    // `live`: a snapshot the caller already read, so a list of ids costs one registry read (R100).
    if (this.owner(calendarId, live ?? (await this.deps.mailboxes.list()))) return true;
    const row = await this.deps.contacts.resolveCalendar(calendarId);
    return typeof row?.contactId === 'string' && (canonicalUuid(row.contactId) ?? row.contactId) === this.principalContactId;
  }

  /** A live mailbox by id; unknown and removed ids are CalendarRouteErrors. */
  async mailbox(id: string): Promise<PrincipalMailboxView> {
    try {
      return await this.deps.mailboxes.get(id);
    } catch (err) {
      if (err instanceof RemovedMailboxError) {
        const live = await this.deps.mailboxes.list();
        throw new CalendarRouteError('mailbox_removed', `Mailbox "${id}" (${err.label}) has been removed.`, options(live), { id, label: err.label });
      }
      if (err instanceof UnknownMailboxError) {
        const live = await this.deps.mailboxes.list();
        throw new CalendarRouteError(
          'unknown_mailbox',
          live.length > 0 ? `Unknown mailbox "${id}"; pass one of: ${choices(live)}.` : `Unknown mailbox "${id}"; no principal mailbox is connected.`,
          options(live),
        );
      }
      throw err;
    }
  }

  /** True when the id names a live mailbox; false when it was removed (or never existed). */
  async isLive(id: string): Promise<boolean> {
    try {
      await this.deps.mailboxes.get(id);
      return true;
    } catch (err) {
      if (err instanceof RemovedMailboxError || err instanceof UnknownMailboxError) return false;
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
    // One registry read per call: the owner check and the sole-mailbox fallback share it.
    const live = await this.deps.mailboxes.list();

    if (calendarId === PRIMARY_CALENDAR_ALIAS) {
      const mb = hinted ?? this.soleMailbox('primary_alias_needs_mailbox', calendarId, live);
      const client = await this.deps.mailboxes.calendarClient(mb.id);
      return { mailboxId: mb.id, calendarId: await this.homeCalendarId(mb.id, client, live), client, placedBy: 'primary' };
    }

    // The owning grant wins over a registry row too: a row written before the rule (or by the
    // backfill) can name another mailbox the calendar is merely shared into.
    const owner = this.owner(calendarId, live);
    if (owner) return { mailboxId: owner.id, calendarId, client: await this.deps.mailboxes.calendarClient(owner.id), placedBy: 'owner' };

    const row = await this.deps.contacts.resolveCalendar(calendarId);
    if (row?.principalMailboxId) {
      const mb = live.find((m) => m.id === row.principalMailboxId) ?? (await this.registeredMailbox(calendarId, row.principalMailboxId, live));
      if (hinted && hinted.id !== mb.id) {
        this.log.info({ mailboxId: mb.id, hintedMailboxId: hinted.id }, 'Registered calendar routed to its own mailbox, not the hint');
      }
      return { mailboxId: mb.id, calendarId, client: await this.deps.mailboxes.calendarClient(mb.id), placedBy: 'registry' };
    }

    // Not placed by the registry (unregistered, or a row the boot backfill has not assigned).
    const mb = hinted ?? this.soleMailbox('needs_mailbox', calendarId, live);
    return { mailboxId: mb.id, calendarId, client: await this.deps.mailboxes.calendarClient(mb.id), placedBy: hinted ? 'hint' : 'sole' };
  }

  /**
   * For a calendar neither its address nor a registry row places: another live mailbox whose
   * account owns it (Nylas `isOwnedByUser`), if any (SEC-L1). A write through a mailbox it is only
   * shared into would go out as the wrong identity. Fails closed (R106): when another mailbox's
   * calendars cannot be listed and no owner was found, it throws `owner_unconfirmed` rather than
   * let the write go out through the hinted account.
   */
  async ownedElsewhere(calendarId: string, mailboxId: string): Promise<PrincipalMailboxView | undefined> {
    const live = await this.deps.mailboxes.list();
    if (live.length < 2 || this.owner(calendarId, live)) return undefined;
    if ((await this.deps.contacts.resolveCalendar(calendarId))?.principalMailboxId) return undefined;
    const id = lower(calendarId);
    const unlisted: PrincipalMailboxView[] = [];
    for (const m of live) {
      if (m.id === mailboxId) continue;
      try {
        const listed = await (await this.deps.mailboxes.calendarClient(m.id)).listCalendars();
        if (listed.some((c) => c.isOwnedByUser && lower(c.id) === id)) return m;
      } catch (err) {
        this.log.warn({ mailboxId: m.id, errName: err instanceof Error ? err.name : 'Error' }, 'Could not list a mailbox\'s calendars to check who owns a calendar; refusing');
        unlisted.push(m);
      }
    }
    if (unlisted.length > 0) {
      throw new CalendarRouteError(
        'owner_unconfirmed',
        `Could not confirm which account owns calendar "${calendarId}": the calendars of ${choices(unlisted)} could not be listed. ` +
          'Nothing was changed; try again shortly.',
        options(live),
      );
    }
    return undefined;
  }

  /**
   * The mailbox a registry row names when it is not among the live ones. A removed mailbox is
   * refused, never replaced by another (R75); the message names the recovery: re-register the
   * calendar through a live mailbox (calendar-register moves such a row, R77).
   */
  private async registeredMailbox(calendarId: string, mailboxId: string, live: PrincipalMailboxView[]): Promise<PrincipalMailboxView> {
    try {
      return await this.mailbox(mailboxId);
    } catch (err) {
      if (err instanceof CalendarRouteError && err.code === 'mailbox_removed') {
        const next = live.length > 0 ? `mailbox as one of: ${choices(live)}` : 'a mailbox once one is connected';
        throw new CalendarRouteError(
          'mailbox_removed',
          `Calendar "${calendarId}" was registered through mailbox "${mailboxId}", which has been removed. ` +
            `To use it again, re-register it with calendar-register, passing ${next}.`,
          options(live),
          err.removedMailbox,
        );
      }
      throw err;
    }
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
    const live = await this.deps.mailboxes.list();
    const owner = this.owner(calendarId, live);
    if (owner) return { mailboxId: owner.id, owner: true };
    const mb = hinted ?? this.soleMailbox('needs_mailbox', calendarId, live);
    return { mailboxId: mb.id, owner: false };
  }

  /**
   * Every home calendar, for availability (D7): each live mailbox's, looked up on its own (one
   * that cannot be found is a `failure`, never silently skipped), plus the home calendars the
   * registry still holds for removed mailboxes (`removed`: no client, their grant is gone).
   */
  async homeCalendars(): Promise<{
    found: Array<RoutedCalendar & { label: string }>;
    failures: Array<{ mailboxId: string; label: string; code: string; error: unknown }>;
    removed: Array<{ mailboxId: string; calendarId: string; label: string }>;
  }> {
    const { found, failures } = await this.liveHomeCalendarsSettled();
    const liveIds = new Set([...found.map((f) => f.mailboxId), ...failures.map((f) => f.mailboxId)]);
    const removed: Array<{ mailboxId: string; calendarId: string; label: string }> = [];
    const rows = await this.deps.contacts.getCalendarsForContact(this.deps.principalContactId);
    for (const row of rows) {
      if (!row.isPrimary || !row.principalMailboxId || liveIds.has(row.principalMailboxId)) continue;
      try {
        await this.deps.mailboxes.get(row.principalMailboxId);
      } catch (err) {
        if (err instanceof RemovedMailboxError) {
          removed.push({ mailboxId: row.principalMailboxId, calendarId: row.nylasCalendarId, label: err.label });
          continue;
        }
        throw err;
      }
    }
    return { found, failures, removed };
  }

  /**
   * Every live mailbox's home calendar, each looked up on its own: a mailbox whose home calendar
   * cannot be found is a `failure` (its id, a code and a grant-safe reason), and the others are
   * still `found`. One broken account must not hide the others' calendars or holds.
   */
  async liveHomeCalendarsSettled(): Promise<{
    found: Array<RoutedCalendar & { label: string }>;
    failures: Array<{ mailboxId: string; label: string; code: string; error: unknown }>;
  }> {
    const live = await this.deps.mailboxes.list();
    const found: Array<RoutedCalendar & { label: string }> = [];
    const failures: Array<{ mailboxId: string; label: string; code: string; error: unknown }> = [];
    for (const mb of live) {
      try {
        const client = await this.deps.mailboxes.calendarClient(mb.id);
        found.push({ mailboxId: mb.id, calendarId: await this.homeCalendarId(mb.id, client, live), client, label: mb.label });
      } catch (err) {
        const code = err instanceof CalendarRouteError ? err.code : err instanceof Error ? err.name : 'Error';
        this.log.warn({ mailboxId: mb.id, code }, 'Home calendar lookup failed for one mailbox');
        failures.push({ mailboxId: mb.id, label: mb.label, code, error: err });
      }
    }
    return { found, failures };
  }

  /** The live mailbox whose own address is this calendar ID (that account's calendar), if any. */
  private owner(calendarId: string, live: PrincipalMailboxView[]): PrincipalMailboxView | undefined {
    const id = lower(calendarId);
    if (!id.includes('@')) return undefined;
    return live.find((m) => m.address !== '' && lower(m.address) === id);
  }

  /** The one live mailbox, or the error naming the choices when there are several (or none). */
  private soleMailbox(code: 'needs_mailbox' | 'primary_alias_needs_mailbox', calendarId: string, live: PrincipalMailboxView[]): PrincipalMailboxView {
    if (live.length === 1) return live[0]!;
    if (live.length === 0) throw new CalendarRouteError('no_mailbox', NO_MAILBOX_MESSAGE);
    this.log.info({ code, liveCount: live.length }, 'Calendar call needs a mailbox');
    if (code === 'primary_alias_needs_mailbox') {
      throw new CalendarRouteError(code, `"primary" is ambiguous with ${live.length} mailboxes connected; pass mailbox as one of: ${choices(live)}.`, options(live));
    }
    throw new CalendarRouteError(code, `Calendar "${calendarId}" is not registered to a mailbox; pass mailbox as one of: ${choices(live)}.`, options(live));
  }

  /**
   * A mailbox's home calendar ID: the principal's primary calendar registered for it (unless
   * another live mailbox owns that calendar), else the grant's own primary calendar as Nylas
   * lists it (its real ID, never the alias).
   */
  private async homeCalendarId(mailboxId: string, client: NylasCalendarClient, live: PrincipalMailboxView[]): Promise<string> {
    const registered = await this.deps.contacts.getPrimaryCalendar(this.deps.principalContactId, mailboxId);
    if (registered) {
      // The owning grant wins here too, as on the address path: a row naming another live
      // mailbox's own calendar is not this mailbox's home, and writing to it through this
      // mailbox's client would reach the other account. The grant's own primary is used instead.
      const owner = this.owner(registered.nylasCalendarId, live);
      if (!owner || owner.id === mailboxId) return registered.nylasCalendarId;
      this.log.warn({ mailboxId, ownerMailboxId: owner.id }, 'Registered home calendar belongs to another mailbox; using the grant\'s own primary');
    }
    const primary = (await client.listCalendars()).find((c) => c.isPrimary);
    if (!primary) {
      this.log.warn({ mailboxId }, 'Mailbox grant lists no primary calendar');
      throw new CalendarRouteError('no_home_calendar', `Mailbox "${mailboxId}" has no primary calendar; pass a calendar ID instead of "primary".`);
    }
    // The grant's listed primary must be this account's own too: one that another live mailbox
    // owns (a shared calendar the provider marks primary) is not written through this client.
    const owner = this.owner(primary.id, live);
    if (owner && owner.id !== mailboxId) {
      this.log.warn({ mailboxId, ownerMailboxId: owner.id }, "Mailbox grant's primary calendar belongs to another mailbox; refused");
      throw new CalendarRouteError('no_home_calendar', `Mailbox "${mailboxId}" lists another mailbox's calendar as its primary; pass a calendar ID instead of "primary".`);
    }
    return primary.id;
  }
}
