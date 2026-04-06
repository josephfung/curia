import { describe, it, expect, vi } from 'vitest';
import { CalendarCheckConflictsHandler } from '../../../skills/calendar-check-conflicts/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('CalendarCheckConflictsHandler', () => {
  const handler = new CalendarCheckConflictsHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({ calendarIds: ['cal-1'], proposedStart: 'a', proposedEnd: 'b' }));
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
    if (!result.success) expect(result.error).toContain('proposedStart');
  });

  it('returns clear=true and empty conflicts when no busy periods', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{ email: 'cal-1', timeSlots: [] }]),
    };
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], proposedStart: '2026-04-01T09:00:00Z', proposedEnd: '2026-04-01T10:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { conflicts: unknown[]; clear: boolean };
      expect(data.clear).toBe(true);
      expect(data.conflicts).toHaveLength(0);
    }
  });

  it('returns conflicts when busy periods overlap proposed time', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        timeSlots: [
          { startTime: 1000, endTime: 2000, status: 'busy' },
        ],
      }]),
    };
    const contactService = {
      resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'c1', label: 'Work', isPrimary: true, readOnly: false }),
      getContact: vi.fn().mockResolvedValue({ id: 'c1', displayName: 'Joseph Fung' }),
    };

    // Proposed time overlaps with the busy period
    const result = await handler.execute(makeCtx(
      { calendarIds: ['cal-1'], proposedStart: '1970-01-01T00:00:00Z', proposedEnd: '1970-01-01T01:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { conflicts: Array<{ calendarId: string; contactName: string | null; startTime: string; endTime: string }>; clear: boolean };
      expect(data.clear).toBe(false);
      expect(data.conflicts).toHaveLength(1);
      expect(data.conflicts[0].contactName).toBe('Joseph Fung');
      // Timestamps must be ISO strings, not raw Unix seconds (1000s → 16:40, 2000s → 33:20)
      expect(data.conflicts[0].startTime).toBe('1970-01-01T00:16:40.000Z');
      expect(data.conflicts[0].endTime).toBe('1970-01-01T00:33:20.000Z');
    }
  });

  it('returns clear=true when no overlap', async () => {
    const nylasCalendarClient = {
      getFreeBusy: vi.fn().mockResolvedValue([{
        email: 'cal-1',
        // Busy from 0 to 100 — proposed time is 200-300, no overlap
        timeSlots: [{ startTime: 0, endTime: 100, status: 'busy' }],
      }]),
    };
    const result = await handler.execute(makeCtx(
      // These ISO strings translate to times WAY after timestamp 100
      { calendarIds: ['cal-1'], proposedStart: '2026-04-01T09:00:00Z', proposedEnd: '2026-04-01T10:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { clear: boolean };
      expect(data.clear).toBe(true);
    }
  });
});
