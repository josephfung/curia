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

    // Free/busy lives on the `calendars` resource in the Nylas v8 SDK
    // (POST /v3/grants/{identifier}/calendars/free-busy). There is no
    // top-level `calendars_free_busy` resource — calling one crashes at runtime.
    getFreeBusy(params: {
      identifier: string;
      requestBody: Record<string, unknown>;
    }): Promise<{ data: NylasRawFreeBusy[] }>;
  };

  events: {
    list(params: {
      identifier: string;
      queryParams?: Record<string, unknown>;
    }): Promise<{ data: NylasRawEvent[] }>;

    find(params: {
      identifier: string;
      eventId: string;
      queryParams?: Record<string, unknown>;
    }): Promise<{ data: NylasRawEvent }>;

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

    sendRsvp(params: {
      identifier: string;
      eventId: string;
      queryParams: Record<string, unknown>;
      requestBody: { status: NylasRsvpStatus };
    }): Promise<NylasRawRsvpResponse>;

    destroy(params: {
      identifier: string;
      eventId: string;
      queryParams?: Record<string, unknown>;
    }): Promise<void>;
  };

}

// -- Raw Nylas SDK types (subset we use) --
//
// The Nylas SDK v8 runs objKeysToCamelCase() on all API responses before returning
// them, so runtime objects use camelCase — not the snake_case of the raw REST API.
// These interfaces must match the *SDK output*, not the wire format.

interface NylasRawCalendar {
  id: string;
  name?: string;
  description?: string;
  timezone?: string;
  isPrimary?: boolean;
  readOnly?: boolean;
  isOwnedByUser?: boolean;
}

interface NylasRawEvent {
  id: string;
  title?: string;
  description?: string;
  location?: string;
  // 'when' is a discriminated union (Timespan | Time | Date | Datespan).
  // All field names are camelCase after the SDK's objKeysToCamelCase transform.
  when?: {
    // Timespan — regular timed events
    startTime?: number;
    endTime?: number;
    // Date — single all-day events
    date?: string;
    // Datespan — multi-day all-day events
    startDate?: string;
    endDate?: string;
    object?: string;
  };
  participants?: Array<{
    email: string;
    name?: string;
    status?: string;
  }>;
  conferencing?: Record<string, unknown>;
  status?: string;
  calendarId?: string;
  busy?: boolean;
  metadata?: Record<string, string>;
}

interface NylasRawFreeBusy {
  email: string;
  // Nylas returns a discriminated array: success entries (object "free_busy", with
  // timeSlots) and per-calendar error entries (object "error", carrying `error` and
  // no timeSlots). Both fields are optional so the error variant can be detected.
  object?: string;
  error?: string;
  timeSlots?: Array<{
    startTime: number;
    endTime: number;
    status: string;
  }>;
}

interface NylasRawRsvpResponse {
  requestId?: string;
  sendIcsError?: unknown;
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
  /** Arbitrary string key/value pairs attached to the event by Curia (e.g. `{ "curia-hold": "true" }`). Null when absent. */
  metadata: Record<string, string> | null;
}

export interface NylasFreeBusyResult {
  email: string;
  timeSlots: Array<{
    startTime: number;
    endTime: number;
    status: string;
  }>;
}

export type NylasRsvpStatus = 'yes' | 'no' | 'maybe';

export interface NylasRsvpResult {
  requestId: string | null;
  sendIcsError: unknown | null;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: Array<{ email: string; name?: string }>;
  conferencing?: Record<string, unknown>;
  /** Arbitrary string key/value pairs to attach to the event (e.g. `{ "curia-hold": "true" }`). Values must be strings (Nylas requirement). */
  metadata?: Record<string, string>;
  /** Event status (e.g. "tentative", "confirmed", "cancelled"). */
  status?: string;
  /** Whether the event should block calendar time. Defaults to true in Nylas. */
  busy?: boolean;
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
    const startUnix = this.toUnixSeconds(timeMin, 'timeMin');
    const endUnix = this.toUnixSeconds(timeMax, 'timeMax');
    if (endUnix <= startUnix) {
      throw new Error(`Invalid time range: timeMax must be after timeMin (timeMin="${timeMin}", timeMax="${timeMax}")`);
    }
    try {
      const response = await this.nylas.events.list({
        identifier: this.grantId,
        queryParams: {
          calendar_id: calendarId,
          start: startUnix,
          end: endUnix,
          limit: opts?.limit ?? 200,
        },
      });
      return (response?.data ?? []).map((evt) => this.normalizeEvent(evt));
    } catch (err) {
      this.log.error({ err, calendarId }, 'Nylas listEvents failed');
      throw err;
    }
  }

  /** Fetch one event by ID from a calendar. */
  async getEvent(calendarId: string, eventId: string): Promise<NylasCalendarEvent> {
    this.log.debug({ calendarId, eventId }, 'Fetching event');
    try {
      const response = await this.nylas.events.find({
        identifier: this.grantId,
        eventId,
        queryParams: { calendar_id: calendarId },
      });
      return this.normalizeEvent(response.data);
    } catch (err) {
      this.log.error({ err, calendarId, eventId }, 'Nylas getEvent failed');
      throw err;
    }
  }

  /** Create a new event on a calendar. */
  async createEvent(calendarId: string, event: CreateEventInput): Promise<NylasCalendarEvent> {
    this.log.debug({ calendarId, title: event.title }, 'Creating event');
    const startUnix = this.toUnixSeconds(event.start, 'start');
    const endUnix = this.toUnixSeconds(event.end, 'end');
    if (endUnix <= startUnix) {
      throw new Error(`Invalid time range: end must be after start (start="${event.start}", end="${event.end}")`);
    }
    try {
      const requestBody: Record<string, unknown> = {
        title: event.title,
        when: {
          start_time: startUnix,
          end_time: endUnix,
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
      // Conditionally include metadata/status/busy so existing create calls are byte-for-byte unchanged.
      if (event.metadata) requestBody.metadata = event.metadata;
      if (event.status) requestBody.status = event.status;
      if (typeof event.busy === 'boolean') requestBody.busy = event.busy;

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
          ...(changes.start ? { start_time: this.toUnixSeconds(changes.start, 'start') } : {}),
          ...(changes.end ? { end_time: this.toUnixSeconds(changes.end, 'end') } : {}),
        };
      }
      if (changes.attendees) {
        requestBody.participants = changes.attendees.map((a) => ({
          email: a.email,
          name: a.name ?? '',
        }));
      }
      if (changes.conferencing !== undefined) requestBody.conferencing = changes.conferencing;
      // Conditionally include metadata/status/busy so existing update calls are byte-for-byte unchanged.
      if (changes.metadata) requestBody.metadata = changes.metadata;
      if (changes.status) requestBody.status = changes.status;
      if (typeof changes.busy === 'boolean') requestBody.busy = changes.busy;

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

  /** Respond to an event invitation as the authenticated attendee. */
  async sendRsvp(calendarId: string, eventId: string, status: NylasRsvpStatus): Promise<NylasRsvpResult> {
    this.log.debug({ calendarId, eventId, status }, 'Sending event RSVP');
    try {
      const response = await this.nylas.events.sendRsvp({
        identifier: this.grantId,
        eventId,
        queryParams: { calendar_id: calendarId },
        requestBody: { status },
      });
      return {
        requestId: typeof response.requestId === 'string' ? response.requestId : null,
        sendIcsError: response.sendIcsError ?? null,
      };
    } catch (err) {
      this.log.error({ err, calendarId, eventId, status }, 'Nylas sendRsvp failed');
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
    const startUnix = this.toUnixSeconds(timeMin, 'timeMin');
    const endUnix = this.toUnixSeconds(timeMax, 'timeMax');
    if (endUnix <= startUnix) {
      throw new Error(`Invalid time range: timeMax must be after timeMin (timeMin="${timeMin}", timeMax="${timeMax}")`);
    }
    try {
      const response = await this.nylas.calendars.getFreeBusy({
        identifier: this.grantId,
        requestBody: {
          start_time: startUnix,
          end_time: endUnix,
          emails: calendarIds,
        },
      });
      const entries = response?.data ?? [];
      // A per-calendar error entry (object "error" / has `error`, no timeSlots) must
      // NOT be collapsed to an empty slot list — that would read an unreadable
      // calendar as fully free and let a conflict check double-book the principal.
      // Fail loud so the caller (calendar-check-conflicts / -find-free-time) surfaces
      // it instead of silently scheduling over an unknown.
      const errored = entries.filter((fb) => fb.object === 'error' || fb.error != null);
      if (errored.length > 0) {
        for (const e of errored) {
          this.log.error({ email: e.email, error: e.error }, 'Nylas getFreeBusy returned an error entry for a calendar');
        }
        throw new Error(
          `Free/busy lookup failed for ${errored.length} calendar(s): ${errored.map((e) => e.email).join(', ')}`,
        );
      }
      return entries.map((fb) => ({
        email: fb.email,
        timeSlots: (fb.timeSlots ?? []).map((ts) => ({
          startTime: ts.startTime,
          endTime: ts.endTime,
          status: ts.status,
        })),
      }));
    } catch (err) {
      this.log.error({ err, calendarIds }, 'Nylas getFreeBusy failed');
      throw err;
    }
  }

  // -- Helpers --

  /** Convert an ISO 8601 string to Unix seconds, throwing on unparseable input. */
  private toUnixSeconds(iso: string, label: string): number {
    const unix = Math.floor(new Date(iso).getTime() / 1000);
    if (Number.isNaN(unix)) {
      throw new Error(`Invalid ${label} timestamp: "${iso}" — expected ISO 8601`);
    }
    return unix;
  }

  // -- Normalizers --

  private normalizeCalendar(cal: NylasRawCalendar): NylasCalendar {
    // Warn if isOwnedByUser is absent — default to false (safe side) to avoid
    // granting write access to calendars the user may not own.
    if (cal.isOwnedByUser === undefined) {
      this.log.warn({ calendarId: cal.id }, 'normalizeCalendar: isOwnedByUser missing — defaulting to false');
    }
    return {
      id: cal.id,
      name: cal.name ?? '',
      description: cal.description ?? '',
      timezone: cal.timezone ?? '',
      isPrimary: cal.isPrimary ?? false,
      readOnly: cal.readOnly ?? false,
      isOwnedByUser: cal.isOwnedByUser ?? false,
    };
  }

  private normalizeEvent(evt: NylasRawEvent): NylasCalendarEvent {
    return {
      id: evt.id,
      title: evt.title ?? '',
      description: evt.description ?? '',
      location: evt.location ?? '',
      startTime: evt.when?.startTime ?? null,
      endTime: evt.when?.endTime ?? null,
      // For single all-day events (Date type), expose the date as both startDate and endDate
      startDate: evt.when?.startDate ?? evt.when?.date ?? null,
      endDate: evt.when?.endDate ?? evt.when?.date ?? null,
      participants: (evt.participants ?? []).map((p) => ({
        email: p.email,
        name: p.name ?? '',
        status: p.status ?? 'noreply',
      })),
      conferencing: evt.conferencing ?? null,
      status: evt.status ?? 'confirmed',
      calendarId: evt.calendarId ?? '',
      busy: evt.busy ?? true,
      metadata: evt.metadata ?? null,
    };
  }
}
