import { describe, it, expect, vi } from 'vitest';
import { CalendarDeleteEventHandler } from '../../../skills/calendar/tools/calendar-delete-event/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import pino from 'pino';
import { singleMailboxRouter } from '../../../skills/_shared/calendar-router-test-helpers.js';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<ToolContext>): ToolContext {
  return { toolName: 'calendar-delete-event', toolVersion: '1.0.0', input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('CalendarDeleteEventHandler', () => {
  const handler = new CalendarDeleteEventHandler();

  it('returns failure when the calendar router is not available', async () => {
    const result = await handler.execute(makeCtx({ calendarId: 'cal-1', eventId: 'evt-1' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Calendar not configured');
  });

  it('returns failure when required inputs are missing', async () => {
    const nylasCalendarClient = { deleteEvent: vi.fn() };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1' },
      { calendarRouter: singleMailboxRouter(nylasCalendarClient) },
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
      { calendarRouter: singleMailboxRouter(nylasCalendarClient), contactService: contactService as never },
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
      { calendarRouter: singleMailboxRouter(nylasCalendarClient), contactService: contactService as never },
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { deleted: boolean };
      expect(data.deleted).toBe(true);
    }
  });

  it('names the Microsoft limit when a silent delete gets a 400', async () => {
    const badRequest = Object.assign(new Error('400 Bad Request'), { statusCode: 400 });
    const nylasCalendarClient = { deleteEvent: vi.fn().mockRejectedValue(badRequest) };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', eventId: 'evt-1', notifyAttendees: false },
      { calendarRouter: singleMailboxRouter(nylasCalendarClient) },
    ));
    expect(nylasCalendarClient.deleteEvent).toHaveBeenCalledWith('cal-1', 'evt-1', false);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('400 Bad Request');
      expect(result.error).toContain('Microsoft calendars reject notifyAttendees=false');
    }
  });

  it('adds no Microsoft hint when a silent delete times out (outcome unknown)', async () => {
    const nylasCalendarClient = { deleteEvent: vi.fn().mockRejectedValue(new Error('Nylas SDK timed out')) };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', eventId: 'evt-1', notifyAttendees: false },
      { calendarRouter: singleMailboxRouter(nylasCalendarClient) },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('timed out');
      expect(result.error).not.toContain('was not deleted');
    }
  });

  it('adds no Microsoft hint when a notifying delete fails', async () => {
    const nylasCalendarClient = { deleteEvent: vi.fn().mockRejectedValue(new Error('404 Not Found')) };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', eventId: 'evt-1' },
      { calendarRouter: singleMailboxRouter(nylasCalendarClient) },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).not.toContain('Microsoft');
  });
});
