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
    const workEvents = [
      { ...mockEvents[1], id: 'work-1', startTime: '2026-04-01T14:00:00Z' },
    ];
    const personalEvents = [
      { ...mockEvents[0], id: 'personal-1', startTime: '2026-04-01T09:00:00Z' },
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
      // personal-1 (09:00) should sort before work-1 (14:00)
      expect(data.events[0].id).toBe('personal-1');
      expect(data.events[1].id).toBe('work-1');
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
