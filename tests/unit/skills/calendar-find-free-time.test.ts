import { describe, it, expect, vi } from 'vitest';
import { CalendarFindFreeTimeHandler } from '../../../skills/calendar-find-free-time/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

// Realistic Unix timestamps (seconds) on 2026-04-06.
// 1775476800 = 2026-04-06T12:00:00Z (8:00 AM EDT)
// Busy: 12:30Z–13:00Z and 14:30Z–15:00Z
const mockFreeBusy = [
  {
    email: 'cal-1',
    timeSlots: [
      { startTime: 1775478600, endTime: 1775480400, status: 'busy' }, // 12:30Z–13:00Z
      { startTime: 1775485800, endTime: 1775487600, status: 'busy' }, // 14:30Z–15:00Z
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

    // Range: 12:00Z–16:00Z, busy at 12:30Z–13:00Z and 14:30Z–15:00Z
    // Free windows: 12:00Z–12:30Z, 13:00Z–14:30Z, 15:00Z–16:00Z
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '2026-04-06T12:00:00Z', timeMax: '2026-04-06T16:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string; end: string }> };
      expect(data.freeWindows).toEqual([
        { start: '2026-04-06T12:00:00.000Z', end: '2026-04-06T12:30:00.000Z' },
        { start: '2026-04-06T13:00:00.000Z', end: '2026-04-06T14:30:00.000Z' },
        { start: '2026-04-06T15:00:00.000Z', end: '2026-04-06T16:00:00.000Z' },
      ]);
    }
  });

  it('omits free windows with suspicious timestamps (epoch-zero guard)', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [
          // A corrupt slot with startTime=0 from Nylas would produce a free window starting at 0
          { startTime: 0, endTime: 1775476800, status: 'busy' },
        ],
      }]),
    };

    // Range: 12:00Z–13:00Z, entire range is "busy" from 0–12:00Z
    // No free windows at all
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '2026-04-06T12:00:00Z', timeMax: '2026-04-06T13:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string | null; end: string | null }> };
      // The free window after the busy period (12:00Z–13:00Z) should have valid timestamps
      // but there should be no window starting at epoch 0
      for (const w of data.freeWindows) {
        expect(w.start).not.toContain('1970');
        expect(w.end).not.toContain('1970');
      }
    }
  });

  it('filters by minimum duration', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [
          // Busy 12:10Z–12:20Z (10 min) — splits into a short window (10 min) and a long one
          { startTime: 1775477400, endTime: 1775478000, status: 'busy' },
        ],
      }]),
    };

    // Range: 12:00Z–13:00Z, busy 12:10Z–12:20Z
    // Free: 12:00Z–12:10Z (600s) and 12:20Z–13:00Z (2400s)
    // 5 min = 300s filter keeps both; but using 15 min = 900s keeps only the longer window
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '2026-04-06T12:00:00Z', timeMax: '2026-04-06T13:00:00Z', duration: 15 },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: string; end: string }> };
      expect(data.freeWindows).toEqual([
        { start: '2026-04-06T12:20:00.000Z', end: '2026-04-06T13:00:00.000Z' },
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
