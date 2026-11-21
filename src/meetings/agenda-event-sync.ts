// agenda-event-sync.ts — an agenda tied to a calendar event follows the event (#2360).
//
// No webhooks: each sweep re-reads every pending event-tied agenda's event by id.
// Moved → the agenda's scheduled_for follows. Cancelled or gone → the agenda is
// closed and the owner task wakes once to ask when instead. Access refused, an
// unroutable calendar, or an event with no timed start and end → the owner wakes
// once and the event is not read again. A route error that usually clears (a mailbox
// reconnecting, or needing a hint) is skipped, and only after 24 hours of it in a row does
// it count as unreadable. About to start → the owner wakes once to nudge
// the principal. Ended with nothing loaded → the owner wakes once about the
// no-show. Bookkeeping is written before each wake, so a failed write never
// repeats a wake. General to any calendar-tied agenda, not only onboarding.

import type { Logger } from '../logger.js';
import { grantSafeErrorFields, mayCarryGrantId } from '../principal-mailboxes/error-fields.js';
import { CalendarRouteError, type CalendarRouter } from '../channels/calendar/calendar-router.js';
import { nylasStatus } from '../channels/email/nylas-message-id.js';
import type { AgendaStore } from './agenda-store.js';
import {
  AGENDA_EVENT_SYNC_INTERVAL_MINUTES,
  EVENT_UNREACHABLE_GRACE_HOURS,
  NO_SHOW_GRACE_MINUTES,
  SESSION_NUDGE_LEAD_MINUTES,
} from './constants.js';
import type { AgendaDoc } from './types.js';

export interface AgendaCalendarEvent {
  start: Date;
  end: Date;
  status: 'confirmed' | 'cancelled';
}

/**
 * `getEvent` result when the event can never be read: access refused (401/403, the grant was
 * revoked or is invalid) or the calendar no longer routes to a mailbox.
 */
export const EVENT_UNREADABLE = 'unreadable' as const;
/** `getEvent` result for an event with no timed start and end (an all-day event). */
export const EVENT_UNTIMED = 'untimed' as const;

/**
 * `getEvent` result when a route error that usually clears stopped the read: the principal's
 * mailbox is briefly disconnected (`no_mailbox`), or a second mailbox now needs a hint
 * (`needs_mailbox`). The sync skips the sweep and only gives up after a grace period.
 */
export const EVENT_UNREACHABLE = 'unreachable' as const;

export type AgendaEventRead =
  | AgendaCalendarEvent
  | null
  | typeof EVENT_UNREADABLE
  | typeof EVENT_UNTIMED
  | typeof EVENT_UNREACHABLE;

/** Route errors that usually clear on their own; every other CalendarRouteError is permanent. */
const TRANSIENT_ROUTE_CODES: readonly string[] = ['no_mailbox', 'needs_mailbox'];

export interface AgendaEventSyncOptions {
  store: Pick<AgendaStore, 'listPending' | 'reschedule' | 'markEvent' | 'close'>;
  /**
   * The event; null when the calendar says it does not exist; EVENT_UNREADABLE when it can never
   * be read; EVENT_UNTIMED when it has no timed start and end; EVENT_UNREACHABLE when a
   * usually-temporary route error stopped the read. Any other failure throws and is
   * retried next sweep.
   */
  getEvent: (calendarId: string, eventId: string) => Promise<AgendaEventRead>;
  /** Add a progress note to the owner task and wake it. */
  wakeOwner: (taskId: string, note: string) => Promise<void>;
  logger: Logger;
  intervalMinutes?: number;
}

export const CANCELLED_NOTE = 'Session event cancelled: ask once when to do it instead';
export const NUDGE_NOTE = 'Session starting: nudge the principal (call, or open it in chat)';
export const NO_SHOW_NOTE =
  'Missed session: send one "missed you, when suits better?" and book the answer, unless the session happened in chat (then send nothing).';
export const UNREADABLE_NOTE =
  "Can't read this session's calendar event (calendar access may have been removed): check with the principal how to proceed";
/** After EVENT_UNREACHABLE_GRACE_HOURS of a route error that usually clears (no_mailbox / needs_mailbox). */
export const UNREACHABLE_NOTE =
  "Can't reach this session's calendar event for a day: the principal's mailbox is disconnected, or a second mailbox needs choosing for the calendar. Check with the principal how to proceed";
export const UNTIMED_NOTE =
  "This session's calendar event has no start and end time (an all-day event?): check with the principal when to hold it";

/**
 * Read an agenda's event through the calendar router. A calendar that no longer routes (its
 * mailbox removed, or unregistered) and a refused grant are EVENT_UNREADABLE; a gone event is
 * null; a missing mailbox or one needing a hint is EVENT_UNREACHABLE (usually temporary); anything else (network, rate limit, a route that may resolve shortly) throws.
 */
export async function readAgendaEvent(
  router: Pick<CalendarRouter, 'route'>,
  calendarId: string,
  eventId: string,
): Promise<AgendaEventRead> {
  let routed: Awaited<ReturnType<CalendarRouter['route']>>;
  try {
    routed = await router.route(calendarId);
  } catch (err) {
    if (err instanceof CalendarRouteError) {
      // no_mailbox / needs_mailbox usually clear (a reconnect, a hint); the sync gives them a grace period.
      if (TRANSIENT_ROUTE_CODES.includes(err.code)) return EVENT_UNREACHABLE;
      // owner_unconfirmed is a listing failure that may clear; every other route error is permanent.
      if (err.code !== 'owner_unconfirmed') return EVENT_UNREADABLE;
    }
    throw err;
  }
  let event: Awaited<ReturnType<typeof routed.client.getEvent>>;
  try {
    event = await routed.client.getEvent(routed.calendarId, eventId);
  } catch (err) {
    const status = nylasStatus(err);
    // A 404 means the event is gone (deleted), which the sync treats as cancelled.
    if (status === 404) return null;
    // 401/403: access refused (grant revoked or invalid). Reported once, not retried forever.
    if (status === 401 || status === 403) return EVENT_UNREADABLE;
    throw err;
  }
  if (event.startTime === null || event.endTime === null) return EVENT_UNTIMED;
  return {
    start: new Date(event.startTime * 1000),
    end: new Date(event.endTime * 1000),
    status: event.status === 'cancelled' ? 'cancelled' : 'confirmed',
  };
}

const MINUTE_MS = 60_000;

export class AgendaEventSync {
  private handle: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  constructor(private readonly o: AgendaEventSyncOptions) {}

  start(): void {
    if (this.handle) return;
    const ms = (this.o.intervalMinutes ?? AGENDA_EVENT_SYNC_INTERVAL_MINUTES) * MINUTE_MS;
    this.handle = setInterval(() => {
      if (this.tickInFlight) return;
      this.tickInFlight = true;
      this.tick(new Date()).finally(() => {
        this.tickInFlight = false;
      });
    }, ms);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /** One sweep. Errors are logged, never thrown; one agenda's failure does not stop the others. */
  async tick(now: Date): Promise<void> {
    let pending: AgendaDoc[];
    try {
      pending = await this.o.store.listPending(now);
    } catch (err) {
      this.o.logger.error({ err }, 'agenda event sync: listing pending agendas failed');
      return;
    }
    for (const agenda of pending) {
      if (!agenda.calendarEventId || !agenda.calendarId) continue;
      // Already reported: the owner was told once and the event is not read again.
      if (agenda.eventState === 'cancelled' || agenda.eventState === 'unreadable') continue;
      try {
        await this.syncOne(agenda, agenda.calendarId, agenda.calendarEventId, now);
      } catch (err) {
        this.o.logger.error({ err, agendaId: agenda.agendaId }, 'agenda event sync: agenda sync failed');
      }
    }
  }

  private async syncOne(agenda: AgendaDoc, calendarId: string, eventId: string, now: Date): Promise<void> {
    let event: AgendaEventRead;
    try {
      event = await this.o.getEvent(calendarId, eventId);
    } catch (err) {
      // Unreadable this time (network, rate limit): try again next sweep. The message is logged
      // only for an error that cannot carry a Nylas grant id (R20).
      const message = err instanceof Error && !mayCarryGrantId(err) ? { errMessage: err.message } : {};
      this.o.logger.warn(
        { ...grantSafeErrorFields(err), ...message, agendaId: agenda.agendaId },
        'agenda event sync: could not read the event, skipping this sweep',
      );
      return;
    }

    if (event === EVENT_UNREACHABLE) {
      await this.onUnreachable(agenda, now);
      return;
    }

    // Never readable as a session time: told once, then not read again.
    if (event === EVENT_UNREADABLE || event === EVENT_UNTIMED) {
      const marked = await this.o.store.markEvent(agenda.agendaId, { eventState: 'unreadable', eventUnreachableSince: null });
      if (marked) await this.wake(agenda, event === EVENT_UNTIMED ? UNTIMED_NOTE : UNREADABLE_NOTE);
      return;
    }

    if (event === null || event.status === 'cancelled') {
      // Closed, not just marked: a pending cancelled agenda could preload onto an unrelated call.
      const closed = await this.o.store.close(agenda.agendaId, { eventState: 'cancelled' });
      if (closed) await this.wake(agenda, CANCELLED_NOTE);
      return;
    }

    let current = agenda;
    // Reachable again: the grace clock starts over.
    if (agenda.eventUnreachableSince !== null) {
      const cleared = await this.o.store.markEvent(agenda.agendaId, { eventUnreachableSince: null });
      if (!cleared) return;
      current = cleared;
    }
    const scheduledAt = agenda.scheduledFor === null ? Number.NaN : Date.parse(agenda.scheduledFor);
    if (scheduledAt !== event.start.getTime()) {
      const moved = await this.o.store.reschedule(current.agendaId, event.start);
      if (!moved) return;
      current = moved;
    }

    const startMs = event.start.getTime();
    const endMs = event.end.getTime();
    const nowMs = now.getTime();

    // A session already over gets no "starting" nudge; the no-show check below covers it.
    if (current.nudgedAt === null && nowMs >= startMs - SESSION_NUDGE_LEAD_MINUTES * MINUTE_MS && nowMs < endMs) {
      const marked = await this.o.store.markEvent(current.agendaId, { nudgedAt: now.toISOString() });
      if (marked) await this.wake(current, NUDGE_NOTE);
      return;
    }

    if (
      nowMs >= endMs + NO_SHOW_GRACE_MINUTES * MINUTE_MS
      && current.status === 'pending'
      && current.history.length === 0
      && current.eventState !== 'no_show'
    ) {
      const marked = await this.o.store.markEvent(current.agendaId, { eventState: 'no_show' });
      if (marked) await this.wake(current, NO_SHOW_NOTE);
    }
  }

  /**
   * A usually-temporary route error: record when it started and skip the sweep. Once it has
   * lasted EVENT_UNREACHABLE_GRACE_HOURS, treat the event as unreadable (owner woken once).
   */
  private async onUnreachable(agenda: AgendaDoc, now: Date): Promise<void> {
    const sinceMs = agenda.eventUnreachableSince === null ? Number.NaN : Date.parse(agenda.eventUnreachableSince);
    if (Number.isNaN(sinceMs)) {
      // First failure (or an unparseable since-time): start the clock now.
      await this.o.store.markEvent(agenda.agendaId, { eventUnreachableSince: now.toISOString() });
      this.o.logger.warn(
        { agendaId: agenda.agendaId },
        'agenda event sync: the event is unreachable (mailbox missing or needs a hint), skipping this sweep',
      );
      return;
    }
    if (now.getTime() - sinceMs < EVENT_UNREACHABLE_GRACE_HOURS * 60 * MINUTE_MS) {
      // Warned once at the first failure; the sweeps inside the grace period are routine.
      this.o.logger.info(
        { agendaId: agenda.agendaId, since: agenda.eventUnreachableSince },
        'agenda event sync: the event is still unreachable, skipping this sweep',
      );
      return;
    }
    const marked = await this.o.store.markEvent(agenda.agendaId, { eventState: 'unreadable', eventUnreachableSince: null });
    if (marked) await this.wake(agenda, UNREACHABLE_NOTE);
  }

  private async wake(agenda: AgendaDoc, note: string): Promise<void> {
    if (!agenda.ownerTaskId) {
      this.o.logger.info({ agendaId: agenda.agendaId, note }, 'agenda event sync: no owner task to wake');
      return;
    }
    await this.o.wakeOwner(agenda.ownerTaskId, note);
  }
}
