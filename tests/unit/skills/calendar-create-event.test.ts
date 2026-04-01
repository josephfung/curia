import { describe, it, expect, vi } from 'vitest';
import { CalendarCreateEventHandler } from '../../../skills/calendar-create-event/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('CalendarCreateEventHandler', () => {
  const handler = new CalendarCreateEventHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({ calendarId: 'cal-1', title: 'Test', start: '2026-04-01T09:00:00Z', end: '2026-04-01T10:00:00Z' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Calendar not configured');
  });

  it('returns failure when required inputs are missing', async () => {
    const nylasCalendarClient = { createEvent: vi.fn() };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', title: 'Test' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('start');
  });

  it('rejects creation on read-only calendar', async () => {
    const nylasCalendarClient = { createEvent: vi.fn() };
    const contactService = {
      resolveCalendar: vi.fn().mockResolvedValue({ contactId: 'c1', label: 'Work', isPrimary: true, readOnly: true }),
    };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', title: 'Test', start: '2026-04-01T09:00:00Z', end: '2026-04-01T10:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('read-only');
    expect(nylasCalendarClient.createEvent).not.toHaveBeenCalled();
  });

  it('creates event successfully when calendar is writable', async () => {
    const createdEvent = { id: 'evt-new', title: 'Team Meeting', description: '', location: '', startTime: 1000, endTime: 2000, startDate: null, endDate: null, participants: [], conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true };
    const nylasCalendarClient = { createEvent: vi.fn().mockResolvedValue(createdEvent) };
    const contactService = {
      resolveCalendar: vi.fn().mockResolvedValue(null), // unregistered = proceed
    };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', title: 'Team Meeting', start: '2026-04-01T09:00:00Z', end: '2026-04-01T10:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { event: { id: string } };
      expect(data.event.id).toBe('evt-new');
    }
  });

  it('creates event without contactService check when not provided', async () => {
    const createdEvent = { id: 'evt-new', title: 'Test', description: '', location: '', startTime: 1000, endTime: 2000, startDate: null, endDate: null, participants: [], conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true };
    const nylasCalendarClient = { createEvent: vi.fn().mockResolvedValue(createdEvent) };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', title: 'Test', start: '2026-04-01T09:00:00Z', end: '2026-04-01T10:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(true);
  });
});
