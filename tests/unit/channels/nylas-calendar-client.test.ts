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
      (sdk.calendars.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'cal-1',
          name: 'Joseph Work',
          description: 'Main calendar',
          timezone: 'America/Toronto',
          is_primary: true,
          read_only: false,
          is_owned_by_user: false,
        }],
      });

      const calendars = await client.listCalendars();

      expect(calendars).toHaveLength(1);
      expect(calendars[0]).toEqual({
        id: 'cal-1',
        name: 'Joseph Work',
        description: 'Main calendar',
        timezone: 'America/Toronto',
        isPrimary: true,
        readOnly: false,
        isOwnedByUser: false,
      });
    });
  });

  describe('listEvents', () => {
    it('calls SDK events.list with correct params', async () => {
      await client.listEvents('cal-1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');

      expect(sdk.events.list).toHaveBeenCalledWith({
        identifier: 'grant-123',
        queryParams: {
          calendar_id: 'cal-1',
          start: '2026-04-01T00:00:00Z',
          end: '2026-04-02T00:00:00Z',
          limit: 200,
        },
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

      expect(sdk.calendars_free_busy.list).toHaveBeenCalledWith({
        identifier: 'grant-123',
        requestBody: {
          start_time: '2026-04-01T00:00:00Z',
          end_time: '2026-04-02T00:00:00Z',
          emails: ['cal-1', 'cal-2'],
        },
      });
    });
  });
});
