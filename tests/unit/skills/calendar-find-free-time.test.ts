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
      const data = result.data as { freeWindows: Array<{ start: number; end: number }> };
      expect(data.freeWindows.length).toBeGreaterThan(0);
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
    // With duration filter of 300 seconds (5 minutes) minimum, only the 200-1000 window qualifies
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], timeMin: '1970-01-01T00:00:00Z', timeMax: '1970-01-01T00:16:40Z', duration: 300 },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { freeWindows: Array<{ start: number; end: number }> };
      expect(data.freeWindows).toHaveLength(1);
      // The window should be at least 300 seconds long
      for (const w of data.freeWindows) {
        expect(w.end - w.start).toBeGreaterThanOrEqual(300);
      }
    }
  });
});
