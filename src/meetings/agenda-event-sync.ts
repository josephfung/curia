// agenda-event-sync.ts — an agenda tied to a calendar event follows the event (#2360).
//
// No webhooks: each sweep re-reads every pending event-tied agenda's event by id.
// Moved → the agenda's scheduled_for follows. Cancelled or gone → the owner task
// wakes once to ask when instead. About to start → the owner wakes once to nudge
// the principal. Ended with nothing loaded → the owner wakes once about the
// no-show. Bookkeeping is written before each wake, so a failed write never
// repeats a wake. General to any calendar-tied agenda, not only onboarding.

import type { Logger } from '../logger.js';
import { grantSafeErrorFields } from '../principal-mailboxes/error-fields.js';
import type { AgendaStore } from './agenda-store.js';
import {
  AGENDA_EVENT_SYNC_INTERVAL_MINUTES,
  NO_SHOW_GRACE_MINUTES,
  SESSION_NUDGE_LEAD_MINUTES,
} from './constants.js';
import type { AgendaDoc } from './types.js';

export interface AgendaCalendarEvent {
  start: Date;
  end: Date;
  status: 'confirmed' | 'cancelled';
}

export interface AgendaEventSyncOptions {
  store: Pick<AgendaStore, 'listPending' | 'reschedule' | 'markEvent'>;
  /** The event, or null when the calendar says it does not exist. Any other failure throws. */
  getEvent: (calendarId: string, eventId: string) => Promise<AgendaCalendarEvent | null>;
  /** Add a progress note to the owner task and wake it. */
  wakeOwner: (taskId: string, note: string) => Promise<void>;
  logger: Logger;
  intervalMinutes?: number;
}

export const CANCELLED_NOTE = 'Session event cancelled: ask once when to do it instead';
export const NUDGE_NOTE = 'Session starting: nudge the principal (call, or open it in chat)';
export const NO_SHOW_NOTE = 'Missed session: one "missed you, when suits better?"';

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
      // Cancellation was already handled: the owner asked for a new time, which books a new agenda.
      if (agenda.eventState === 'cancelled') continue;
      try {
        await this.syncOne(agenda, agenda.calendarId, agenda.calendarEventId, now);
      } catch (err) {
        this.o.logger.error({ err, agendaId: agenda.agendaId }, 'agenda event sync: agenda sync failed');
      }
    }
  }

  private async syncOne(agenda: AgendaDoc, calendarId: string, eventId: string, now: Date): Promise<void> {
    let event: AgendaCalendarEvent | null;
    try {
      event = await this.o.getEvent(calendarId, eventId);
    } catch (err) {
      // Unreadable this time (network, rate limit, no calendar connected): try again next sweep.
      // Class and status only: a Nylas error can carry the grant id (R20).
      this.o.logger.warn({ ...grantSafeErrorFields(err), agendaId: agenda.agendaId }, 'agenda event sync: could not read the event, skipping this sweep');
      return;
    }

    if (event === null || event.status === 'cancelled') {
      const marked = await this.o.store.markEvent(agenda.agendaId, { eventState: 'cancelled' });
      if (marked) await this.wake(agenda, CANCELLED_NOTE);
      return;
    }

    let current = agenda;
    const scheduledAt = agenda.scheduledFor === null ? Number.NaN : Date.parse(agenda.scheduledFor);
    if (scheduledAt !== event.start.getTime()) {
      const moved = await this.o.store.reschedule(agenda.agendaId, event.start);
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

  private async wake(agenda: AgendaDoc, note: string): Promise<void> {
    if (!agenda.ownerTaskId) {
      this.o.logger.info({ agendaId: agenda.agendaId, note }, 'agenda event sync: no owner task to wake');
      return;
    }
    await this.o.wakeOwner(agenda.ownerTaskId, note);
  }
}
