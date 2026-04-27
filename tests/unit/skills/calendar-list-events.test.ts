// tests/unit/skills/calendar-list-events.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CalendarListEventsHandler } from '../../../skills/calendar-list-events/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

const mockEvents = [
  { id: 'evt-1', title: 'Team Standup', description: 'Daily sync', participants: [{ email: 'alice@co.com', name: 'Alice', status: 'accepted' }], startTime: 1000, endTime: 2000, startDate: null, endDate: null, location: '', conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true },
  { id: 'evt-2', title: 'Chiropractor', description: 'Appointment at 2pm', participants: [], startTime: 3000, endTime: 4000, startDate: null, endDate: null, location: '123 Main St', conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true },
  { id: 'evt-3', title: 'Board Meeting', description: '', participants: [{ email: 'bob@co.com', name: 'Bob', status: 'accepted' }], startTime: 5000, endTime: 6000, startDate: null, endDate: null, location: '', conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true },
];

describe('CalendarListEventsHandler', () => {
  const handler = new CalendarListEventsHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({ calendarId: 'cal-1', timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Calendar not configured');
  });

  it('returns failure when required inputs are missing', async () => {
    const nylasCalendarClient = { listEvents: vi.fn() };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('timeMin');
  });

  it('returns all events in range when no filters provided', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: unknown[]; count: number };
      expect(data.events).toHaveLength(3);
      expect(data.count).toBe(3);
    }
    expect(nylasCalendarClient.listEvents).toHaveBeenCalledWith('cal-1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z', undefined);
  });

  it('filters by query (case-insensitive substring on title)', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z', query: 'chiropractor' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }>; count: number };
      expect(data.events).toHaveLength(1);
      expect(data.events[0].id).toBe('evt-2');
    }
  });

  it('filters by query matching description', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z', query: 'daily sync' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }> };
      expect(data.events).toHaveLength(1);
      expect(data.events[0].id).toBe('evt-1');
    }
  });

  it('filters by attendeeEmail', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z', attendeeEmail: 'bob@co.com' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }> };
      expect(data.events).toHaveLength(1);
      expect(data.events[0].id).toBe('evt-3');
    }
  });

  // -- Auto-resolve caller calendars (no calendarId provided) --

  it('resolves caller calendars when calendarId is omitted', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue([mockEvents[0]]),
    };
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-work' },
        { nylasCalendarId: 'cal-personal' },
      ]),
    };

    const result = await handler.execute(makeCtx(
      { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      {
        nylasCalendarClient: nylasCalendarClient as never,
        contactService: contactService as never,
        caller: { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      },
    ));

    expect(result.success).toBe(true);
    // Should have queried both calendars
    expect(nylasCalendarClient.listEvents).toHaveBeenCalledTimes(2);
    expect(nylasCalendarClient.listEvents).toHaveBeenCalledWith('cal-work', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z', undefined);
    expect(nylasCalendarClient.listEvents).toHaveBeenCalledWith('cal-personal', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z', undefined);
    expect(contactService.getCalendarsForContact).toHaveBeenCalledWith('primary-user');
  });

  it('merges and sorts events from multiple calendars chronologically', async () => {
    // startTime is Unix seconds (as returned by Nylas SDK) — smaller = earlier
    const workEvents = [
      { ...mockEvents[1], id: 'work-1', startTime: 5000 },
    ];
    const personalEvents = [
      { ...mockEvents[0], id: 'personal-1', startTime: 1000 },
    ];
    const nylasCalendarClient = {
      listEvents: vi.fn()
        .mockResolvedValueOnce(workEvents)
        .mockResolvedValueOnce(personalEvents),
    };
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-work' },
        { nylasCalendarId: 'cal-personal' },
      ]),
    };

    const result = await handler.execute(makeCtx(
      { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      {
        nylasCalendarClient: nylasCalendarClient as never,
        contactService: contactService as never,
        caller: { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }> };
      expect(data.events).toHaveLength(2);
      // personal-1 (startTime: 1000) should sort before work-1 (startTime: 5000)
      expect(data.events[0].id).toBe('personal-1');
      expect(data.events[1].id).toBe('work-1');
    }
  });

  it('sorts all-day events by startDate, not as epoch 0', async () => {
    // Regression: before the fix, startTime=null fell back to 0, placing all-day events
    // before every timed event regardless of their actual date.
    const allDayLaterInWeek = {
      id: 'allday-later', title: 'Conference Day', description: '', participants: [],
      startTime: null, endTime: null, startDate: '2026-04-08', endDate: '2026-04-08',
      location: '', conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: false,
    };
    const timedEarlierInWeek = {
      id: 'timed-earlier', title: 'Morning Call', description: '', participants: [],
      startTime: 1775466000, endTime: 1775469600, // 2026-04-06T09:00Z – 10:00Z
      startDate: null, endDate: null,
      location: '', conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true,
    };
    const nylasCalendarClient = {
      // Return in "wrong" order (all-day first) so the sort must fix it
      listEvents: vi.fn().mockResolvedValue([allDayLaterInWeek, timedEarlierInWeek]),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-06T00:00:00Z', timeMax: '2026-04-09T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }> };
      // timed-earlier (2026-04-06) must come before allday-later (2026-04-08)
      expect(data.events[0].id).toBe('timed-earlier');
      expect(data.events[1].id).toBe('allday-later');
    }
  });

  it('formats timed event timestamps in the configured timezone', async () => {
    // 1775489400 Unix seconds = 2026-04-06T15:30:00Z = 11:30 AM EDT (UTC-4)
    // 1775491200 Unix seconds = 2026-04-06T16:00:00Z = 12:00 PM EDT (UTC-4)
    const timedEvent = {
      id: 'evt-timed',
      title: 'Catchup',
      description: '',
      participants: [],
      startTime: 1775489400,
      endTime: 1775491200,
      startDate: null,
      endDate: null,
      location: '',
      conferencing: null,
      status: 'confirmed',
      calendarId: 'cal-1',
      busy: true,
    };
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue([timedEvent]),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-06T00:00:00Z', timeMax: '2026-04-07T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never, timezone: 'America/Toronto' },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ startTime: string; endTime: string }>; displayTimezone: string };
      // Wall-clock digits should be in EDT (UTC-4), not UTC
      expect(data.events[0].startTime).toBe('2026-04-06T11:30:00.000-04:00');
      expect(data.events[0].endTime).toBe('2026-04-06T12:00:00.000-04:00');
      expect(data.displayTimezone).toContain('EDT');
    }
  });

  it('falls back to UTC ISO strings when timezone is not provided', async () => {
    const timedEvent = {
      id: 'evt-timed',
      title: 'Catchup',
      description: '',
      participants: [],
      startTime: 1775489400,
      endTime: 1775491200,
      startDate: null,
      endDate: null,
      location: '',
      conferencing: null,
      status: 'confirmed',
      calendarId: 'cal-1',
      busy: true,
    };
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue([timedEvent]),
    };

    // No timezone in context — should fall back to UTC Z-suffix
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-06T00:00:00Z', timeMax: '2026-04-07T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ startTime: string; endTime: string }>; displayTimezone: null };
      expect(data.events[0].startTime).toBe('2026-04-06T15:30:00.000Z');
      expect(data.events[0].endTime).toBe('2026-04-06T16:00:00.000Z');
      expect(data.displayTimezone).toBeNull();
    }
  });

  it('leaves startTime/endTime null for all-day events', async () => {
    const allDayEvent = {
      id: 'evt-allday',
      title: 'Birthday',
      description: '',
      participants: [],
      startTime: null,
      endTime: null,
      startDate: '2026-04-06',
      endDate: '2026-04-06',
      location: '',
      conferencing: null,
      status: 'confirmed',
      calendarId: 'cal-1',
      busy: false,
    };
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue([allDayEvent]),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-06T00:00:00Z', timeMax: '2026-04-07T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ startTime: null; endTime: null; startDate: string }> };
      expect(data.events[0].startTime).toBeNull();
      expect(data.events[0].endTime).toBeNull();
      expect(data.events[0].startDate).toBe('2026-04-06');
    }
  });

  it('nulls out and warns on suspicious startTime values (0, negative, non-finite)', async () => {
    // Unix 0 is never a real calendar time — a Nylas bug returning 0 would silently
    // produce "1970-01-01T00:00:00Z" without this guard.
    const suspectEvent = {
      id: 'evt-suspect',
      title: 'Corrupted event',
      description: '',
      participants: [],
      startTime: 0,
      endTime: -1,
      startDate: null,
      endDate: null,
      location: '',
      conferencing: null,
      status: 'confirmed',
      calendarId: 'cal-1',
      busy: true,
    };
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue([suspectEvent]),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-06T00:00:00Z', timeMax: '2026-04-07T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ startTime: null; endTime: null }> };
      // Should be nulled out, not passed as a 1970 date
      expect(data.events[0].startTime).toBeNull();
      expect(data.events[0].endTime).toBeNull();
    }
  });

  it('returns failure when no calendars are registered for caller', async () => {
    const nylasCalendarClient = { listEvents: vi.fn() };
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([]),
    };

    const result = await handler.execute(makeCtx(
      { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      {
        nylasCalendarClient: nylasCalendarClient as never,
        contactService: contactService as never,
        caller: { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('No calendars registered');
  });

  it('returns failure when no calendarId and no contactService', async () => {
    const nylasCalendarClient = { listEvents: vi.fn() };

    const result = await handler.execute(makeCtx(
      { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('calendarId');
  });

  it('returns failure (not throws) when getCalendarsForContact rejects', async () => {
    const nylasCalendarClient = { listEvents: vi.fn() };
    const contactService = {
      getCalendarsForContact: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    };

    const result = await handler.execute(makeCtx(
      { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      {
        nylasCalendarClient: nylasCalendarClient as never,
        contactService: contactService as never,
        caller: { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('DB connection lost');
  });

  it('returns partial results with warnings when one calendar fails', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn()
        .mockResolvedValueOnce([mockEvents[0]])
        .mockRejectedValueOnce(new Error('Not Found')),
    };
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-work' },
        { nylasCalendarId: 'cal-stale' },
      ]),
    };

    const result = await handler.execute(makeCtx(
      { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      {
        nylasCalendarClient: nylasCalendarClient as never,
        contactService: contactService as never,
        caller: { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: unknown[]; count: number; warnings?: string[] };
      expect(data.events).toHaveLength(1);
      expect(data.warnings).toBeDefined();
      expect(data.warnings![0]).toContain('cal-stale');
    }
  });

  it('returns failure when all calendars fail', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockRejectedValue(new Error('Not Found')),
    };
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-1' },
        { nylasCalendarId: 'cal-2' },
      ]),
    };

    const result = await handler.execute(makeCtx(
      { timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      {
        nylasCalendarClient: nylasCalendarClient as never,
        contactService: contactService as never,
        caller: { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to list events from any calendar');
  });

  it('respects maxResults limit', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z', maxResults: 2 },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: unknown[]; count: number };
      expect(data.events).toHaveLength(2);
      expect(data.count).toBe(2);
    }
  });
});
