import { describe, it, expect, vi } from 'vitest';
import { CalendarDeleteEventHandler } from '../../../skills/calendar-delete-event/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('CalendarDeleteEventHandler', () => {
  const handler = new CalendarDeleteEventHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({ calendarId: 'cal-1', eventId: 'evt-1' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Calendar not configured');
  });

  it('returns failure when required inputs are missing', async () => {
    const nylasCalendarClient = { deleteEvent: vi.fn() };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('eventId');
  });

  it('rejects deletion on read-only calendar', async () => {
    const nylasCalendarClient = { deleteEvent: vi.fn() };
    const contactService = {
      resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'c1', label: 'Shared', isPrimary: false, readOnly: true }),
    };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', eventId: 'evt-1' },
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('read-only');
    expect(nylasCalendarClient.deleteEvent).not.toHaveBeenCalled();
  });

  it('deletes event successfully', async () => {
    const nylasCalendarClient = { deleteEvent: vi.fn().mockResolvedValue(undefined) };
    const contactService = { resolveCalendar: vi.fn().mockResolvedValue(null) };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', eventId: 'evt-1' },
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { deleted: boolean };
      expect(data.deleted).toBe(true);
    }
  });
});
