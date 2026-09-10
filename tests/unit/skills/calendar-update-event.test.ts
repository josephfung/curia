import { describe, it, expect, vi } from 'vitest';
import { CalendarUpdateEventHandler } from '../../../skills/calendar/tools/calendar-update-event/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import type { NylasCalendarEvent } from '../../../src/channels/calendar/nylas-calendar-client.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<ToolContext>): ToolContext {
  return { toolName: 'calendar-update-event', toolVersion: '1.1.0', input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

function makeEvent(overrides?: Partial<NylasCalendarEvent>): NylasCalendarEvent {
  return {
    id: 'evt-1',
    title: 'Updated',
    description: '',
    location: '',
    startTime: 1775466000,
    endTime: 1775469600,
    startDate: null,
    endDate: null,
    participants: [],
    conferencing: null,
    status: 'confirmed',
    calendarId: 'cal-1',
    busy: true,
    metadata: null,
    ...overrides,
  };
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
    const nylasCalendarClient = { updateEvent: vi.fn().mockResolvedValue(makeEvent()) };
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

  it('rejects attendee RSVP status instead of silently dropping it', async () => {
    const nylasCalendarClient = { updateEvent: vi.fn() };
    const result = await handler.execute(makeCtx(
      {
        calendarId: 'cal-1',
        eventId: 'evt-1',
        attendees: [
          { email: 'a@example.test', name: 'A', status: 'yes' },
          { email: 'b@example.test', name: 'B' },
        ],
      },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/response status cannot be set/i);
      expect(result.error).toContain('calendar-respond-to-invite');
    }
    expect(nylasCalendarClient.updateEvent).not.toHaveBeenCalled();
  });

  it('rejects Google-style responseStatus on an otherwise valid guest-list replace', async () => {
    const nylasCalendarClient = { updateEvent: vi.fn() };
    const result = await handler.execute(makeCtx(
      {
        calendarId: 'cal-1',
        eventId: 'evt-1',
        attendees: [{ email: 'a@example.test', responseStatus: 'accepted' }],
      },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/response status cannot be set/i);
    expect(nylasCalendarClient.updateEvent).not.toHaveBeenCalled();
  });

  it('replaces the full guest list as email and name only', async () => {
    const nylasCalendarClient = {
      updateEvent: vi.fn().mockResolvedValue(makeEvent({
        participants: [
          { email: 'a@example.test', name: 'A', status: 'noreply' },
          { email: 'b@example.test', name: 'B', status: 'yes' },
        ],
      })),
    };
    const result = await handler.execute(makeCtx(
      {
        calendarId: 'cal-1',
        eventId: 'evt-1',
        attendees: [
          { email: 'a@example.test', name: 'A' },
          { email: 'b@example.test', name: 'B' },
        ],
      },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(true);
    expect(nylasCalendarClient.updateEvent).toHaveBeenCalledWith(
      'cal-1',
      'evt-1',
      {
        attendees: [
          { email: 'a@example.test', name: 'A' },
          { email: 'b@example.test', name: 'B' },
        ],
      },
      undefined,
    );
    const attendees = nylasCalendarClient.updateEvent.mock.calls[0]![2].attendees as Array<Record<string, unknown>>;
    expect(attendees).toHaveLength(2);
    for (const attendee of attendees) {
      expect(attendee).not.toHaveProperty('status');
    }
  });

  it('fails when the provider response omits a requested attendee', async () => {
    const nylasCalendarClient = {
      updateEvent: vi.fn().mockResolvedValue(makeEvent({
        participants: [{ email: 'a@example.test', name: 'A', status: 'noreply' }],
      })),
    };
    const result = await handler.execute(makeCtx(
      {
        calendarId: 'cal-1',
        eventId: 'evt-1',
        attendees: [
          { email: 'a@example.test', name: 'A' },
          { email: 'b@example.test', name: 'B' },
        ],
      },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/did not include/i);
      expect(result.error).not.toMatch(/success/i);
    }
  });

  it('passes notifyAttendees through and warns that Microsoft/iCloud still notify', async () => {
    const nylasCalendarClient = { updateEvent: vi.fn().mockResolvedValue(makeEvent()) };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', eventId: 'evt-1', title: 'Quiet update', notifyAttendees: false },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(true);
    expect(nylasCalendarClient.updateEvent).toHaveBeenCalledWith(
      'cal-1',
      'evt-1',
      { title: 'Quiet update' },
      false,
    );
    if (result.success) {
      const data = result.data as { warnings?: string[] };
      expect(data.warnings?.[0]).toMatch(/Microsoft and iCloud/i);
    }
  });
});
