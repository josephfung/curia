// skills/calendar-check-conflicts/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { CalendarCheckConflictsHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {
      calendarIds: ['test@example.com'],
      proposedStart: '2026-05-26T10:00:00Z',
      proposedEnd: '2026-05-26T11:00:00Z',
    },
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    timezone: 'America/New_York',
    nylasCalendarClient: {
      getFreeBusy: vi.fn().mockResolvedValue([]),
    } as unknown as SkillContext['nylasCalendarClient'],
    ...overrides,
  } as SkillContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CalendarCheckConflictsHandler — free events do not conflict', () => {
  it('reports no conflicts when proposed slot overlaps only free events', async () => {
    const handler = new CalendarCheckConflictsHandler();
    const proposedStart = '2026-05-26T10:00:00Z';
    const proposedEnd = '2026-05-26T11:00:00Z';
    const proposedStartTs = Math.floor(new Date(proposedStart).getTime() / 1000);

    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([
        {
          email: 'test@example.com',
          timeSlots: [
            {
              startTime: proposedStartTs + 600, // overlaps proposed range
              endTime: proposedStartTs + 1200,
              status: 'free',
            },
          ],
        },
      ]),
    } as unknown as SkillContext['nylasCalendarClient'];

    const result = await handler.execute(makeCtx({
      input: {
        calendarIds: ['test@example.com'],
        proposedStart,
        proposedEnd,
      },
      nylasCalendarClient,
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as unknown as { conflicts: Array<unknown>; clear: boolean }).clear).toBe(true);
      expect((result.data as unknown as { conflicts: Array<unknown>; clear: boolean }).conflicts).toHaveLength(0);
    }
  });

  it('reports a conflict when proposed slot overlaps a busy event', async () => {
    const handler = new CalendarCheckConflictsHandler();
    const proposedStart = '2026-05-26T10:00:00Z';
    const proposedEnd = '2026-05-26T11:00:00Z';
    const proposedStartTs = Math.floor(new Date(proposedStart).getTime() / 1000);

    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([
        {
          email: 'test@example.com',
          timeSlots: [
            {
              startTime: proposedStartTs + 600, // overlaps proposed range
              endTime: proposedStartTs + 1200,
              status: 'busy',
            },
          ],
        },
      ]),
    } as unknown as SkillContext['nylasCalendarClient'];

    const result = await handler.execute(makeCtx({
      input: {
        calendarIds: ['test@example.com'],
        proposedStart,
        proposedEnd,
      },
      nylasCalendarClient,
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as unknown as { conflicts: Array<{ status: string }>; clear: boolean };
      expect(data.clear).toBe(false);
      expect(data.conflicts).toHaveLength(1);
      expect(data.conflicts[0]!.status).toBe('busy');
    }
  });

  it('reports conflicts for busy/tentative events, but skips free events in mixed overlaps', async () => {
    const handler = new CalendarCheckConflictsHandler();
    const proposedStart = '2026-05-26T10:00:00Z';
    const proposedEnd = '2026-05-26T11:00:00Z';
    const proposedStartTs = Math.floor(new Date(proposedStart).getTime() / 1000);

    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([
        {
          email: 'test@example.com',
          timeSlots: [
            {
              startTime: proposedStartTs + 600,
              endTime: proposedStartTs + 1200,
              status: 'free',
            },
            {
              startTime: proposedStartTs + 1800,
              endTime: proposedStartTs + 2400,
              status: 'busy',
            },
            {
              startTime: proposedStartTs + 300,
              endTime: proposedStartTs + 900,
              status: 'tentative',
            },
          ],
        },
      ]),
    } as unknown as SkillContext['nylasCalendarClient'];

    const result = await handler.execute(makeCtx({
      input: {
        calendarIds: ['test@example.com'],
        proposedStart,
        proposedEnd,
      },
      nylasCalendarClient,
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as unknown as { conflicts: Array<{ status: string }>; clear: boolean };
      expect(data.clear).toBe(false);
      // Should have 2 conflicts: busy and tentative, but NOT the free event
      expect(data.conflicts).toHaveLength(2);
      const statuses = data.conflicts.map((c) => c.status).sort();
      expect(statuses).toEqual(['busy', 'tentative']);
    }
  });
});
