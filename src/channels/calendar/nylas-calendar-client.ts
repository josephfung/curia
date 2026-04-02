// src/channels/calendar/nylas-calendar-client.ts
//
// Thin wrapper around the Nylas SDK's calendar endpoints.
// Same constructor pattern as NylasClient (email) — takes apiKey, grantId, logger.
// Uses the same Nylas SDK with the same workaround for CJS type declarations.
//
// Provider-agnostic: works with Google Calendar, Microsoft 365/Outlook, or
// any other provider connected through Nylas.

import NylasDefault from 'nylas';
import type { Logger } from '../../logger.js';

/**
 * Minimal typed interface for the Nylas SDK calendar surface.
 * We only declare the subset we use — keeps the CJS workaround small.
 */
export interface NylasCalendarLike {
  calendars: {
    list(params: {
      identifier: string;
    }): Promise<{ data: NylasRawCalendar[] }>;

    find(params: {
      identifier: string;
      calendarId: string;
    }): Promise<{ data: NylasRawCalendar }>;
  };

  events: {
    list(params: {
      identifier: string;
      queryParams?: Record<string, unknown>;
    }): Promise<{ data: NylasRawEvent[] }>;

    create(params: {
      identifier: string;
      queryParams?: Record<string, unknown>;
      requestBody: Record<string, unknown>;
    }): Promise<{ data: NylasRawEvent }>;

    update(params: {
      identifier: string;
      eventId: string;
      queryParams?: Record<string, unknown>;
      requestBody: Record<string, unknown>;
    }): Promise<{ data: NylasRawEvent }>;

    destroy(params: {
      identifier: string;
      eventId: string;
      queryParams?: Record<string, unknown>;
    }): Promise<void>;
  };

  calendars_free_busy: {
    list(params: {
      identifier: string;
      requestBody: Record<string, unknown>;
    }): Promise<{ data: NylasRawFreeBusy[] }>;
  };
}

// -- Raw Nylas SDK types (subset we use) --

interface NylasRawCalendar {
  id: string;
  name?: string;
  description?: string;
  timezone?: string;
  is_primary?: boolean;
  read_only?: boolean;
  is_owned_by_user?: boolean;
}

interface NylasRawEvent {
  id: string;
  title?: string;
  description?: string;
  location?: string;
  when?: {
    start_time?: number;
    end_time?: number;
    start_date?: string;
    end_date?: string;
    object?: string;
  };
  participants?: Array<{
    email: string;
    name?: string;
    status?: string;
  }>;
  conferencing?: Record<string, unknown>;
  status?: string;
  calendar_id?: string;
  busy?: boolean;
  metadata?: Record<string, string>;
}

interface NylasRawFreeBusy {
  email: string;
  time_slots?: Array<{
    start_time: number;
    end_time: number;
    status: string;
  }>;
}

// -- Normalized types --

export interface NylasCalendar {
  id: string;
  name: string;
  description: string;
  timezone: string;
  isPrimary: boolean;
  readOnly: boolean;
  isOwnedByUser: boolean;
}

export interface NylasCalendarEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  startTime: number | null;
  endTime: number | null;
  startDate: string | null;
  endDate: string | null;
  participants: Array<{ email: string; name: string; status: string }>;
  conferencing: Record<string, unknown> | null;
  status: string;
  calendarId: string;
  busy: boolean;
}

export interface NylasFreeBusyResult {
  email: string;
  timeSlots: Array<{
    startTime: number;
    endTime: number;
    status: string;
  }>;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: Array<{ email: string; name?: string }>;
  conferencing?: Record<string, unknown>;
}

// -- SDK constructor workaround (same as email NylasClient) --
// The Nylas SDK v8's type declarations resolve as CJS under TypeScript's nodenext
// module resolution. We work around this by importing the default and casting once.
// TODO: Remove if Nylas ships proper ESM type declarations.

const NylasSDK = NylasDefault as unknown as new (config: { apiKey: string }) => NylasCalendarLike;

// ---------------------------------------------------------------------------
// NylasCalendarClient
// ---------------------------------------------------------------------------

export class NylasCalendarClient {
  private readonly nylas: NylasCalendarLike;
  private readonly grantId: string;
  private readonly log: Logger;

  constructor(apiKey: string, grantId: string, logger: Logger) {
    this.nylas = new NylasSDK({ apiKey });
    this.grantId = grantId;
    this.log = logger.child({ component: 'nylas-calendar-client' });
  }

  /** Create an instance with a pre-built SDK (for testing). */
  static createWithSdk(sdk: NylasCalendarLike, grantId: string, logger: Logger): NylasCalendarClient {
    const instance = Object.create(NylasCalendarClient.prototype) as NylasCalendarClient;
    // Bypass the constructor to inject the mock SDK
    Object.assign(instance, {
      nylas: sdk,
      grantId,
      log: logger.child({ component: 'nylas-calendar-client' }),
    });
    return instance;
  }

  /** List all calendars visible to this grant (owned + shared). */
  async listCalendars(): Promise<NylasCalendar[]> {
    this.log.debug('Listing calendars');
    try {
      const response = await this.nylas.calendars.list({
        identifier: this.grantId,
      });
      return (response?.data ?? []).map((cal) => this.normalizeCalendar(cal));
    } catch (err) {
      this.log.error({ err }, 'Nylas listCalendars failed');
      throw err;
    }
  }

  /** List events for a calendar within a time range. */
  async listEvents(
    calendarId: string,
    timeMin: string,
    timeMax: string,
    opts?: { limit?: number },
  ): Promise<NylasCalendarEvent[]> {
    this.log.debug({ calendarId, timeMin, timeMax }, 'Listing events');
    try {
      const response = await this.nylas.events.list({
        identifier: this.grantId,
        queryParams: {
          calendar_id: calendarId,
          // Nylas expects Unix timestamps (seconds), not ISO strings
          start: Math.floor(new Date(timeMin).getTime() / 1000),
          end: Math.floor(new Date(timeMax).getTime() / 1000),
          limit: opts?.limit ?? 200,
        },
      });
      return (response?.data ?? []).map((evt) => this.normalizeEvent(evt));
    } catch (err) {
      this.log.error({ err, calendarId }, 'Nylas listEvents failed');
      throw err;
    }
  }

  /** Create a new event on a calendar. */
  async createEvent(calendarId: string, event: CreateEventInput): Promise<NylasCalendarEvent> {
    this.log.debug({ calendarId, title: event.title }, 'Creating event');
    try {
      const requestBody: Record<string, unknown> = {
        title: event.title,
        when: {
          start_time: Math.floor(new Date(event.start).getTime() / 1000),
          end_time: Math.floor(new Date(event.end).getTime() / 1000),
        },
      };
      if (event.description) requestBody.description = event.description;
      if (event.location) requestBody.location = event.location;
      if (event.attendees) {
        requestBody.participants = event.attendees.map((a) => ({
          email: a.email,
          name: a.name ?? '',
        }));
      }
      if (event.conferencing) requestBody.conferencing = event.conferencing;

      const response = await this.nylas.events.create({
        identifier: this.grantId,
        queryParams: { calendar_id: calendarId },
        requestBody,
      });
      return this.normalizeEvent(response.data);
    } catch (err) {
      this.log.error({ err, calendarId }, 'Nylas createEvent failed');
      throw err;
    }
  }

  /** Update an existing event. */
  async updateEvent(
    calendarId: string,
    eventId: string,
    changes: Partial<CreateEventInput>,
  ): Promise<NylasCalendarEvent> {
    this.log.debug({ calendarId, eventId }, 'Updating event');
    try {
      const requestBody: Record<string, unknown> = {};
      if (changes.title !== undefined) requestBody.title = changes.title;
      if (changes.description !== undefined) requestBody.description = changes.description;
      if (changes.location !== undefined) requestBody.location = changes.location;
      if (changes.start !== undefined || changes.end !== undefined) {
        requestBody.when = {
          ...(changes.start ? { start_time: Math.floor(new Date(changes.start).getTime() / 1000) } : {}),
          ...(changes.end ? { end_time: Math.floor(new Date(changes.end).getTime() / 1000) } : {}),
        };
      }
      if (changes.attendees) {
        requestBody.participants = changes.attendees.map((a) => ({
          email: a.email,
          name: a.name ?? '',
        }));
      }
      if (changes.conferencing !== undefined) requestBody.conferencing = changes.conferencing;

      const response = await this.nylas.events.update({
        identifier: this.grantId,
        eventId,
        queryParams: { calendar_id: calendarId },
        requestBody,
      });
      return this.normalizeEvent(response.data);
    } catch (err) {
      this.log.error({ err, calendarId, eventId }, 'Nylas updateEvent failed');
      throw err;
    }
  }

  /** Delete an event. Pass notifyAttendees=false to suppress Nylas cancellation emails. */
  async deleteEvent(calendarId: string, eventId: string, notifyAttendees?: boolean): Promise<void> {
    this.log.debug({ calendarId, eventId, notifyAttendees }, 'Deleting event');
    try {
      const queryParams: Record<string, unknown> = { calendar_id: calendarId };
      // Nylas sends cancellation emails by default; only override when explicitly suppressed.
      if (notifyAttendees === false) {
        queryParams.notify_event_creator = false;
      }
      await this.nylas.events.destroy({
        identifier: this.grantId,
        eventId,
        queryParams,
      });
    } catch (err) {
      this.log.error({ err, calendarId, eventId }, 'Nylas deleteEvent failed');
      throw err;
    }
  }

  /** Get free/busy data for one or more calendar IDs across a time range. */
  async getFreeBusy(
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<NylasFreeBusyResult[]> {
    this.log.debug({ calendarIds, timeMin, timeMax }, 'Getting free/busy');
    try {
      const response = await this.nylas.calendars_free_busy.list({
        identifier: this.grantId,
        requestBody: {
          // Nylas expects Unix timestamps (seconds), not ISO strings
          start_time: Math.floor(new Date(timeMin).getTime() / 1000),
          end_time: Math.floor(new Date(timeMax).getTime() / 1000),
          emails: calendarIds,
        },
      });
      return (response?.data ?? []).map((fb) => ({
        email: fb.email,
        timeSlots: (fb.time_slots ?? []).map((ts) => ({
          startTime: ts.start_time,
          endTime: ts.end_time,
          status: ts.status,
        })),
      }));
    } catch (err) {
      this.log.error({ err, calendarIds }, 'Nylas getFreeBusy failed');
      throw err;
    }
  }

  // -- Normalizers --

  private normalizeCalendar(cal: NylasRawCalendar): NylasCalendar {
    return {
      id: cal.id,
      name: cal.name ?? '',
      description: cal.description ?? '',
      timezone: cal.timezone ?? '',
      isPrimary: cal.is_primary ?? false,
      readOnly: cal.read_only ?? false,
      isOwnedByUser: cal.is_owned_by_user ?? true,
    };
  }

  private normalizeEvent(evt: NylasRawEvent): NylasCalendarEvent {
    return {
      id: evt.id,
      title: evt.title ?? '',
      description: evt.description ?? '',
      location: evt.location ?? '',
      startTime: evt.when?.start_time ?? null,
      endTime: evt.when?.end_time ?? null,
      startDate: evt.when?.start_date ?? null,
      endDate: evt.when?.end_date ?? null,
      participants: (evt.participants ?? []).map((p) => ({
        email: p.email,
        name: p.name ?? '',
        status: p.status ?? 'noreply',
      })),
      conferencing: evt.conferencing ?? null,
      status: evt.status ?? 'confirmed',
      calendarId: evt.calendar_id ?? '',
      busy: evt.busy ?? true,
    };
  }
}
