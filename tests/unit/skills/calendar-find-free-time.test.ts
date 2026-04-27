import { describe, it, expect, vi } from 'vitest';
import { CalendarFindFreeTimeHandler } from '../../../skills/calendar-find-free-time/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

// Times as Unix timestamps (seconds)
// Range: 9am-5pm = 32400-61200 seconds (relative, for test purposes we use small numbers)
// Busy: 10-11am = 36000-39600
const mockFreeBusy = [
  {
    email: 'cal-1',
    timeSlots: [
      { startTime: 200, endTime: 400, status: 'busy' }, // busy 200-400
      { startTime: 700, endTime: 900, status: 'busy' }, // busy 700-900
    ],
  },
];

describe('CalendarFindFreeTimeHandler', () => {
  const handler = new CalendarFindFreeTimeHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({ calendarIds: ['cal-1'], timeMin: 'a', timeMax: 'b' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Calendar not configured');
  });

  it('returns failure when required inputs are missing', async () => {
    const nylasCalendarClient = { getFreeBusy: vi.fn() };
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'] },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('timeMin');
  });

  it('returns free windows by inverting busy periods', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue(mockFreeBusy),
    };

    // Range is 0-1000, busy at 200-400 and 700-900
    // Free windows: 0-200, 400-700, 900-1000
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '1970-01-01T00:00:00Z', timeMax: '1970-01-01T00:16:40Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string; end: string }> };
      // Range 0-1000 seconds (epoch), busy 200-400 and 700-900 → free windows: 0-200, 400-700, 900-1000
      // Returned as UTC ISO strings
      expect(data.freeWindows).toEqual([
        { start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T00:03:20.000Z' },
        { start: '1970-01-01T00:06:40.000Z', end: '1970-01-01T00:11:40.000Z' },
        { start: '1970-01-01T00:15:00.000Z', end: '1970-01-01T00:16:40.000Z' },
      ]);
    }
  });

  it('filters by minimum duration', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [
          { startTime: 100, endTime: 200, status: 'busy' },
        ],
      }]),
    };

    // With a range of 0-1000 and busy at 100-200, free windows are 0-100 (100s) and 200-1000 (800s)
    // With duration filter of 5 minutes minimum (converted to 300 seconds), only the 200-1000 window qualifies
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '1970-01-01T00:00:00Z', timeMax: '1970-01-01T00:16:40Z', duration: 5 },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string; end: string }> };
      expect(data.freeWindows).toEqual([
        { start: '1970-01-01T00:03:20.000Z', end: '1970-01-01T00:16:40.000Z' },
      ]);
    }
  });

  it('formats free window timestamps in the configured timezone', async () => {
    // Use realistic timestamps: busy 9:00-10:00 AM EDT on 2026-04-06
    // 1775480400 = 2026-04-06T13:00:00Z = 9:00 AM EDT
    // 1775484000 = 2026-04-06T14:00:00Z = 10:00 AM EDT
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [{ startTime: 1775480400, endTime: 1775484000, status: 'busy' }],
      }]),
    };

    // Query range: 8:00 AM - 12:00 PM EDT
    // 1775476800 = 2026-04-06T12:00:00Z = 8:00 AM EDT
    // 1775491200 = 2026-04-06T16:00:00Z = 12:00 PM EDT
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '2026-04-06T12:00:00Z', timeMax: '2026-04-06T16:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never, timezone: 'America/Toronto' },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string; end: string }>; displayTimezone: string };
      // Free: 8:00-9:00 AM EDT, 10:00 AM-12:00 PM EDT
      expect(data.freeWindows[0].start).toBe('2026-04-06T08:00:00.000-04:00');
      expect(data.freeWindows[0].end).toBe('2026-04-06T09:00:00.000-04:00');
      expect(data.freeWindows[1].start).toBe('2026-04-06T10:00:00.000-04:00');
      expect(data.freeWindows[1].end).toBe('2026-04-06T12:00:00.000-04:00');
      expect(data.displayTimezone).toContain('EDT');
    }
  });

  it('falls back to UTC when timezone is not provided', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [{ startTime: 1775480400, endTime: 1775484000, status: 'busy' }],
      }]),
    };

    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '2026-04-06T12:00:00Z', timeMax: '2026-04-06T16:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string; end: string }>; displayTimezone: null };
      // UTC Z-suffix when no timezone configured
      expect(data.freeWindows[0].start).toBe('2026-04-06T12:00:00.000Z');
      expect(data.displayTimezone).toBeNull();
    }
  });
});
