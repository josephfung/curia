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
    const result = await handler.execute(makeCtx({ calendarId: 'cal-1', timeMin: 'a', timeMax: 'b' }));
    expect(result.success).toBe(false);
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
  });

  it('filters by query (case-insensitive substring on title)', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: 'a', timeMax: 'b', query: 'chiropractor' },
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
      { calendarId: 'cal-1', timeMin: 'a', timeMax: 'b', query: 'daily sync' },
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
      { calendarId: 'cal-1', timeMin: 'a', timeMax: 'b', attendeeEmail: 'bob@co.com' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }> };
      expect(data.events).toHaveLength(1);
      expect(data.events[0].id).toBe('evt-3');
    }
  });

  it('respects maxResults limit', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: 'a', timeMax: 'b', maxResults: 2 },
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
