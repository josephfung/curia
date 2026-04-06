import { describe, it, expect, vi } from 'vitest';
import { CalendarUpdateEventHandler } from '../../../skills/calendar-update-event/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('CalendarUpdateEventHandler', () => {
  const handler = new CalendarUpdateEventHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({ calendarId: 'cal-1', eventId: 'evt-1' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Calendar not configured');
  });

  it('returns failure when required inputs are missing', async () => {
    const nylasCalendarClient = { updateEvent: vi.fn() };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('eventId');
  });

  it('rejects update on read-only calendar', async () => {
    const nylasCalendarClient = { updateEvent: vi.fn() };
    const contactService = {
      resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'c1', label: 'Shared', isPrimary: false, readOnly: true }),
    };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', eventId: 'evt-1', title: 'New Title' },
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('read-only');
    expect(nylasCalendarClient.updateEvent).not.toHaveBeenCalled();
  });

  it('updates event successfully', async () => {
    const updatedEvent = { id: 'evt-1', title: 'Updated', description: '', location: '', startTime: 1775466000, endTime: 1775469600, startDate: null, endDate: null, participants: [], conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true };
    const nylasCalendarClient = { updateEvent: vi.fn().mockResolvedValue(updatedEvent) };
    const contactService = { resolveCalendar: vi.fn().mockResolvedValue(null) };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', eventId: 'evt-1', title: 'Updated' },
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { event: { id: string; startTime: string; endTime: string } };
      expect(data.event.id).toBe('evt-1');
      // Timestamps must be ISO strings, not raw Unix seconds
      expect(data.event.startTime).toBe('2026-04-06T09:00:00.000Z');
      expect(data.event.endTime).toBe('2026-04-06T10:00:00.000Z');
    }
  });
});
