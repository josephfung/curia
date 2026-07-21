// handler.test.ts — unit tests for calendar-find-free-time skill.

import { describe, it, expect, vi } from 'vitest';
import { CalendarFindFreeTimeHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    input: {
      calendarIds: ['cal_1'],
      timeMin: '2026-05-26T09:00:00Z',
      timeMax: '2026-05-26T12:00:00Z',
    },
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    timezone: 'UTC',
    nylasCalendarClient: {
      getFreeBusy: vi.fn().mockResolvedValue([]),
    } as unknown as ToolContext['nylasCalendarClient'],
    ...overrides,
  } as ToolContext;
}

// Helper to convert ISO time to Unix timestamp (seconds)
function isoToTimestamp(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CalendarFindFreeTimeHandler — free vs busy status', () => {
  it('does not let free-status slots block availability; non-free slots still block', async () => {
    const handler = new CalendarFindFreeTimeHandler();

    // Mock getFreeBusy to return one free slot and one busy slot
    const getFreeBusy = vi.fn().mockResolvedValue([{
      email: 'cal_1',
      timeSlots: [
        {
          startTime: isoToTimestamp('2026-05-26T10:00:00Z'),
          endTime: isoToTimestamp('2026-05-26T10:30:00Z'),
          status: 'free',
        },
        {
          startTime: isoToTimestamp('2026-05-26T11:00:00Z'),
          endTime: isoToTimestamp('2026-05-26T11:30:00Z'),
          status: 'busy',
        },
      ],
    }]);

    const result = await handler.execute(makeCtx({
      input: {
        calendarIds: ['cal_1'],
        timeMin: '2026-05-26T09:00:00Z',
        timeMax: '2026-05-26T12:00:00Z',
      },
      nylasCalendarClient: {
        getFreeBusy,
      } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(true);
    const freeWindows = (result as { success: true; data: { freeWindows: Array<{ start: string; end: string }> } }).data.freeWindows;

    // The free slot (10:00-10:30) should NOT block — a free window should cover that time
    // The busy slot (11:00-11:30) SHOULD block — it should carve out that time

    // With no blocking slots, we should have one window from 09:00 to 12:00
    // But the busy slot at 11:00-11:30 should carve it into: 09:00-11:00 and 11:30-12:00
    // The free slot at 10:00-10:30 should NOT carve anything
    expect(freeWindows.length).toBeGreaterThan(0);

    // Check that there's a window covering 10:00-10:30 (free status should not block)
    const hasCoveringWindow = freeWindows.some((w) => {
      const wStart = new Date(w.start).getTime();
      const wEnd = new Date(w.end).getTime();
      const slotStart = new Date('2026-05-26T10:00:00Z').getTime();
      const slotEnd = new Date('2026-05-26T10:30:00Z').getTime();
      return wStart <= slotStart && wEnd >= slotEnd;
    });
    expect(hasCoveringWindow).toBe(true);

    // Check that there's NOT a window covering 11:00-11:30 (busy status should block)
    const hasBusyWindow = freeWindows.some((w) => {
      const wStart = new Date(w.start).getTime();
      const wEnd = new Date(w.end).getTime();
      const busyStart = new Date('2026-05-26T11:00:00Z').getTime();
      // Check if window fully covers the busy slot
      return wStart <= busyStart && wEnd > busyStart;
    });
    expect(hasBusyWindow).toBe(false);
  });
});
