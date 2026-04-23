// tests/unit/channels/nylas-calendar-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

// We test via the public interface, mocking the Nylas SDK at the instance level.
// The NylasCalendarClient constructor creates a Nylas SDK instance internally,
// so we test by constructing the client and then overriding the internal SDK.
// Since the SDK is a private field, we test through the public methods and
// verify behavior via the mock SDK's method calls.

// For testability, NylasCalendarClient accepts an optional NylasLike override
// (same pattern as the email NylasClient could use, but we add it fresh here).

import { NylasCalendarClient } from '../../../src/channels/calendar/nylas-calendar-client.js';
import type { NylasCalendarLike } from '../../../src/channels/calendar/nylas-calendar-client.js';

const logger = pino({ level: 'silent' });

function makeMockSdk(): NylasCalendarLike {
  return {
    calendars: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      find: vi.fn(),
    },
    events: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ data: { id: 'evt-1' } }),
      update: vi.fn().mockResolvedValue({ data: { id: 'evt-1' } }),
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    calendars_free_busy: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  };
}

describe('NylasCalendarClient', () => {
  let client: NylasCalendarClient;
  let sdk: NylasCalendarLike;

  beforeEach(() => {
    sdk = makeMockSdk();
    client = NylasCalendarClient.createWithSdk(sdk, 'grant-123', logger);
  });

  describe('listCalendars', () => {
    it('calls SDK calendars.list with correct grant identifier', async () => {
      await client.listCalendars();

      expect(sdk.calendars.list).toHaveBeenCalledWith({
        identifier: 'grant-123',
      });
    });

    it('returns normalized calendar objects', async () => {
      // Mock data uses camelCase — the Nylas SDK v8 runs objKeysToCamelCase() on
      // all API responses before returning them, so runtime objects are camelCase.
      (sdk.calendars.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'cal-1',
          name: 'Work Calendar',
          description: 'Main calendar',
          timezone: 'America/Toronto',
          isPrimary: true,
          readOnly: false,
          isOwnedByUser: false,
        }],
      });

      const calendars = await client.listCalendars();

      expect(calendars).toHaveLength(1);
      expect(calendars[0]).toEqual({
        id: 'cal-1',
        name: 'Work Calendar',
        description: 'Main calendar',
        timezone: 'America/Toronto',
        isPrimary: true,
        readOnly: false,
        isOwnedByUser: false,
      });
    });

    it('defaults isOwnedByUser to false when missing from SDK response', async () => {
      // Safety-side default: absent isOwnedByUser must NOT grant write access.
      (sdk.calendars.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'cal-unknown',
          name: 'Mystery Calendar',
          description: '',
          timezone: 'UTC',
          isPrimary: false,
          readOnly: false,
          // isOwnedByUser intentionally absent
        }],
      });

      const calendars = await client.listCalendars();

      expect(calendars[0].isOwnedByUser).toBe(false);
    });
  });

  describe('listEvents', () => {
    it('calls SDK events.list with correct params', async () => {
      await client.listEvents('cal-1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');

      expect(sdk.events.list).toHaveBeenCalledWith({
        identifier: 'grant-123',
        queryParams: {
          calendar_id: 'cal-1',
          start: Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000),
          end: Math.floor(new Date('2026-04-02T00:00:00Z').getTime() / 1000),
          limit: 200,
        },
      });
    });

    it('throws on invalid date strings', async () => {
      await expect(client.listEvents('cal-1', 'not-a-date', '2026-04-02T00:00:00Z'))
        .rejects.toThrow(/Invalid timeMin timestamp/);
    });

    it('returns normalized event objects with timestamps from SDK camelCase response', async () => {
      // The Nylas SDK v8 transforms all response keys to camelCase before returning.
      // startTime/endTime on 'when' come back camelCase, not start_time/end_time.
      (sdk.events.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'evt-abc',
          title: 'Karen — Capacity Canada',
          calendarId: 'cal-1',
          status: 'confirmed',
          busy: true,
          when: {
            startTime: 1744027500, // 2026-04-07T18:45:00Z
            endTime: 1744029300,   // 2026-04-07T19:15:00Z
            object: 'timespan',
          },
          participants: [{ email: 'karen@capacity.ca', name: 'Karen', status: 'yes' }],
        }],
      });

      const events = await client.listEvents('cal-1', '2026-04-07T00:00:00Z', '2026-04-08T00:00:00Z');

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: 'evt-abc',
        title: 'Karen — Capacity Canada',
        calendarId: 'cal-1',
        startTime: 1744027500,
        endTime: 1744029300,
        startDate: null,
        endDate: null,
      });
    });

    it('returns normalized all-day event with startDate/endDate', async () => {
      (sdk.events.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'evt-allday',
          title: 'Company Holiday',
          calendarId: 'cal-1',
          status: 'confirmed',
          busy: false,
          when: {
            startDate: '2026-04-10',
            endDate: '2026-04-10',
            object: 'datespan',
          },
        }],
      });

      const events = await client.listEvents('cal-1', '2026-04-07T00:00:00Z', '2026-04-14T00:00:00Z');

      expect(events[0]).toMatchObject({
        startTime: null,
        endTime: null,
        startDate: '2026-04-10',
        endDate: '2026-04-10',
      });
    });
  });

  describe('createEvent', () => {
    it('calls SDK events.create with calendarId and event data', async () => {
      const eventData = {
        title: 'Team Standup',
        start: '2026-04-01T09:00:00Z',
        end: '2026-04-01T09:30:00Z',
      };

      await client.createEvent('cal-1', eventData);

      expect(sdk.events.create).toHaveBeenCalledWith({
        identifier: 'grant-123',
        queryParams: { calendar_id: 'cal-1' },
        requestBody: expect.objectContaining({
          title: 'Team Standup',
        }),
      });
    });
  });

  describe('updateEvent', () => {
    it('calls SDK events.update with eventId and changes', async () => {
      await client.updateEvent('cal-1', 'evt-1', { title: 'Updated' });

      expect(sdk.events.update).toHaveBeenCalledWith({
        identifier: 'grant-123',
        eventId: 'evt-1',
        queryParams: { calendar_id: 'cal-1' },
        requestBody: expect.objectContaining({
          title: 'Updated',
        }),
      });
    });
  });

  describe('deleteEvent', () => {
    it('calls SDK events.destroy with eventId', async () => {
      await client.deleteEvent('cal-1', 'evt-1');

      expect(sdk.events.destroy).toHaveBeenCalledWith({
        identifier: 'grant-123',
        eventId: 'evt-1',
        queryParams: { calendar_id: 'cal-1' },
      });
    });
  });

  describe('getFreeBusy', () => {
    it('calls SDK free-busy endpoint with calendar IDs and time range', async () => {
      await client.getFreeBusy(
        ['cal-1', 'cal-2'],
        '2026-04-01T00:00:00Z',
        '2026-04-02T00:00:00Z',
      );

      // Nylas expects Unix timestamps (seconds), not ISO strings — assert the converted values.
      expect(sdk.calendars_free_busy.list).toHaveBeenCalledWith({
        identifier: 'grant-123',
        requestBody: {
          start_time: Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000),
          end_time: Math.floor(new Date('2026-04-02T00:00:00Z').getTime() / 1000),
          emails: ['cal-1', 'cal-2'],
        },
      });
    });

    it('returns normalized free-busy slots from camelCase SDK response', async () => {
      // The Nylas SDK v8 camelCases the response — timeSlots, startTime, endTime.
      (sdk.calendars_free_busy.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          email: 'cal-1',
          timeSlots: [
            { startTime: 1744027500, endTime: 1744029300, status: 'busy' },
          ],
        }],
      });

      const result = await client.getFreeBusy(['cal-1'], '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        email: 'cal-1',
        timeSlots: [{ startTime: 1744027500, endTime: 1744029300, status: 'busy' }],
      });
    });
  });
});
