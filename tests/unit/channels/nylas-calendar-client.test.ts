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
import type { Logger } from '../../../src/logger.js';

const logger = pino({ level: 'silent' });

function makeMockLogger() {
  const warn = vi.fn();
  const log = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: () => log } as unknown as Logger, warn };
}

function makeMockSdk(): NylasCalendarLike {
  return {
    calendars: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      find: vi.fn(),
      getFreeBusy: vi.fn().mockResolvedValue({ data: [] }),
    },
    events: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      find: vi.fn().mockResolvedValue({ data: { id: 'evt-1' } }),
      create: vi.fn().mockResolvedValue({ data: { id: 'evt-1' } }),
      update: vi.fn().mockResolvedValue({ data: { id: 'evt-1' } }),
      sendRsvp: vi.fn().mockResolvedValue({ requestId: 'req-1' }),
      destroy: vi.fn().mockResolvedValue(undefined),
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

    it('maps Time-type when.time to startTime (#107)', async () => {
      (sdk.events.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'evt-time',
          title: 'Reminder',
          calendarId: 'cal-1',
          status: 'confirmed',
          busy: false,
          when: {
            time: 1744027500,
            object: 'time',
          },
        }],
      });

      const events = await client.listEvents('cal-1', '2026-04-07T00:00:00Z', '2026-04-08T00:00:00Z');

      expect(events[0]).toMatchObject({
        startTime: 1744027500,
        endTime: null,
        startDate: null,
        endDate: null,
      });
    });

    it('prefers when.startTime over when.time when both are present', async () => {
      (sdk.events.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'evt-both',
          title: 'Both fields',
          calendarId: 'cal-1',
          status: 'confirmed',
          busy: true,
          when: {
            startTime: 1744027500,
            endTime: 1744029300,
            time: 9999999999,
            object: 'timespan',
          },
        }],
      });

      const events = await client.listEvents('cal-1', '2026-04-07T00:00:00Z', '2026-04-08T00:00:00Z');

      expect(events[0]?.startTime).toBe(1744027500);
    });

    it('does not warn on a well-formed timespan event', async () => {
      const { logger: mockLog, warn } = makeMockLogger();
      client = NylasCalendarClient.createWithSdk(sdk, 'grant-123', mockLog);
      (sdk.events.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'evt-ok',
          title: 'Normal',
          calendarId: 'cal-1',
          status: 'confirmed',
          busy: true,
          when: { startTime: 1744027500, endTime: 1744029300, object: 'timespan' },
        }],
      });

      await client.listEvents('cal-1', '2026-04-07T00:00:00Z', '2026-04-08T00:00:00Z');

      expect(warn).not.toHaveBeenCalled();
    });

    it('aggregates missing calendarId warns once per listEvents call (#105)', async () => {
      const { logger: mockLog, warn } = makeMockLogger();
      client = NylasCalendarClient.createWithSdk(sdk, 'grant-123', mockLog);
      (sdk.events.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: 'evt-no-cal-1',
            title: 'Orphan 1',
            status: 'confirmed',
            busy: true,
            when: { startTime: 1744027500, endTime: 1744029300, object: 'timespan' },
          },
          {
            id: 'evt-no-cal-2',
            title: 'Orphan 2',
            status: 'confirmed',
            busy: true,
            when: { startTime: 1744027600, endTime: 1744029400, object: 'timespan' },
          },
        ],
      });

      const events = await client.listEvents('cal-1', '2026-04-07T00:00:00Z', '2026-04-08T00:00:00Z');

      expect(events.map((e) => e.calendarId)).toEqual(['', '']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        {
          calendarId: 'cal-1',
          count: 2,
          total: 2,
          sampleEventIds: ['evt-no-cal-1', 'evt-no-cal-2'],
        },
        'normalizeEvent: calendarId missing from Nylas events — possible SDK casing mismatch',
      );
    });

    it('aggregates unrecognized when-shape warns once per listEvents call (#107)', async () => {
      const { logger: mockLog, warn } = makeMockLogger();
      client = NylasCalendarClient.createWithSdk(sdk, 'grant-123', mockLog);
      const weirdWhen = { object: 'mystery', timezone: 'UTC' };
      (sdk.events.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: 'evt-weird',
            title: 'Unknown shape',
            calendarId: 'cal-1',
            status: 'confirmed',
            busy: true,
            when: weirdWhen,
          },
          {
            id: 'evt-absent-when',
            title: 'No when at all',
            calendarId: 'cal-1',
            status: 'confirmed',
            busy: true,
          },
        ],
      });

      const events = await client.listEvents('cal-1', '2026-04-07T00:00:00Z', '2026-04-08T00:00:00Z');

      expect(events).toHaveLength(2);
      expect(events.every((e) => e.startTime === null && e.startDate === null)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        {
          calendarId: 'cal-1',
          count: 2,
          total: 2,
          sampleEventIds: ['evt-weird', 'evt-absent-when'],
          sampleWhen: [weirdWhen, null],
        },
        'normalizeEvent: unrecognized when shape — all timing fields are null',
      );
    });

    it('warns per-event on getEvent when calendarId is missing', async () => {
      const { logger: mockLog, warn } = makeMockLogger();
      client = NylasCalendarClient.createWithSdk(sdk, 'grant-123', mockLog);
      (sdk.events.find as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'evt-single',
          title: 'Orphan',
          status: 'confirmed',
          busy: true,
          when: { startTime: 1744027500, endTime: 1744029300, object: 'timespan' },
        },
      });

      const event = await client.getEvent('cal-1', 'evt-single');

      expect(event.calendarId).toBe('');
      expect(warn).toHaveBeenCalledWith(
        { eventId: 'evt-single' },
        'normalizeEvent: calendarId missing from Nylas event — possible SDK casing mismatch',
      );
    });

    // Nylas v3 returns HTTP 400 "limit must be lower than or equal to 200" for a
    // bigger page, so a >200 total has to come from paging (#1798).
    describe('paging past the 200-event Nylas page cap', () => {
      /** A page of `count` distinct raw timed events, numbered from `from`. */
      function page(from: number, count: number): { data: unknown[] } {
        return {
          data: Array.from({ length: count }, (_, i) => ({
            id: `evt-${from + i}`,
            title: `Event ${from + i}`,
            calendarId: 'cal-1',
            status: 'confirmed',
            busy: true,
            when: { startTime: 1744027500 + from + i, endTime: 1744029300 + from + i, object: 'timespan' },
          })),
        };
      }

      function limitsSentToNylas(): unknown[] {
        return (sdk.events.list as ReturnType<typeof vi.fn>).mock.calls
          .map((call) => (call[0] as { queryParams: { limit: unknown } }).queryParams.limit);
      }

      it('never sends limit > 200, and returns up to maxResults across pages', async () => {
        (sdk.events.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ ...page(0, 200), nextCursor: 'cursor-2' })
          .mockResolvedValueOnce({ ...page(200, 50) });

        const events = await client.listEvents(
          'cal-1', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', { limit: 250 },
        );

        expect(events).toHaveLength(250);
        expect(events[0]?.id).toBe('evt-0');
        expect(events[249]?.id).toBe('evt-249');
        expect(limitsSentToNylas()).toEqual([200, 50]);
      });

      it('passes the cursor as pageToken on follow-up requests only', async () => {
        (sdk.events.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ ...page(0, 200), nextCursor: 'cursor-2' })
          .mockResolvedValueOnce({ ...page(200, 50) });

        await client.listEvents('cal-1', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', { limit: 250 });

        const calls = (sdk.events.list as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0]![0].queryParams).not.toHaveProperty('pageToken');
        expect(calls[1]![0].queryParams).toMatchObject({ pageToken: 'cursor-2' });
      });

      it('stops early when Nylas runs out of events before maxResults', async () => {
        (sdk.events.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ ...page(0, 200) }); // no nextCursor — last page

        const events = await client.listEvents(
          'cal-1', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', { limit: 250 },
        );

        expect(events).toHaveLength(200);
        expect(sdk.events.list).toHaveBeenCalledTimes(1);
      });

      // nextCursor — not an empty page — is Nylas's end-of-results signal, so an
      // empty page followed by a populated one must not cut the fetch short.
      it('keeps paging past an empty page when a cursor is still returned', async () => {
        (sdk.events.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ data: [], nextCursor: 'cursor-2' })
          .mockResolvedValueOnce({ ...page(0, 10) });

        const events = await client.listEvents(
          'cal-1', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', { limit: 250 },
        );

        expect(sdk.events.list).toHaveBeenCalledTimes(2);
        expect(events).toHaveLength(10);
        expect(events[0]?.id).toBe('evt-0');
      });

      it('stops when Nylas hands back a cursor it already gave', async () => {
        (sdk.events.list as ReturnType<typeof vi.fn>)
          .mockResolvedValue({ data: [], nextCursor: 'same-cursor' });

        const events = await client.listEvents(
          'cal-1', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', { limit: 250 },
        );

        expect(events).toHaveLength(0);
        // First response registers the cursor; the second repeats it and breaks.
        expect(sdk.events.list).toHaveBeenCalledTimes(2);
      });

      // A fresh cursor every time with nothing behind it never grows the result,
      // so only the page cap can end this loop.
      it('stops at the page cap when empty pages keep yielding new cursors', async () => {
        let n = 0;
        (sdk.events.list as ReturnType<typeof vi.fn>)
          .mockImplementation(() => Promise.resolve({ data: [], nextCursor: `cursor-${++n}` }));

        const events = await client.listEvents(
          'cal-1', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', { limit: 250 },
        );

        expect(events).toHaveLength(0);
        expect(sdk.events.list).toHaveBeenCalledTimes(25);
      });

      it('caps the total an oversized limit can page for', async () => {
        let n = 0;
        (sdk.events.list as ReturnType<typeof vi.fn>)
          .mockImplementation(() => {
            const from = n * 200;
            n++;
            return Promise.resolve({ ...page(from, 200), nextCursor: `cursor-${n}` });
          });

        const events = await client.listEvents(
          'cal-1', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', { limit: 50_000 },
        );

        expect(events).toHaveLength(1000);
        expect(sdk.events.list).toHaveBeenCalledTimes(5);
        expect(limitsSentToNylas().every((l) => (l as number) <= 200)).toBe(true);
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

    it('maps attendees to email/name only and sets notify_participants', async () => {
      await client.updateEvent(
        'cal-1',
        'evt-1',
        { attendees: [{ email: 'a@example.test', name: 'A' }, { email: 'b@example.test' }] },
        false,
      );

      expect(sdk.events.update).toHaveBeenCalledWith({
        identifier: 'grant-123',
        eventId: 'evt-1',
        queryParams: { calendar_id: 'cal-1', notify_participants: false },
        requestBody: {
          participants: [
            { email: 'a@example.test', name: 'A' },
            { email: 'b@example.test', name: '' },
          ],
        },
      });
      const body = (sdk.events.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].requestBody as {
        participants: Array<Record<string, unknown>>;
      };
      for (const participant of body.participants) {
        expect(participant).not.toHaveProperty('status');
      }
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
      expect(sdk.calendars.getFreeBusy).toHaveBeenCalledWith({
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
      (sdk.calendars.getFreeBusy as ReturnType<typeof vi.fn>).mockResolvedValue({
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
