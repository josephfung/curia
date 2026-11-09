// skills/calendar-update-event/handler.test.ts
//
// Covers recurring-series edits (#2385): changing a series' rule through its
// master event, refusing a rule change aimed at a single instance, and
// refusing inputs the manifest does not declare.

import { describe, it, expect, vi } from 'vitest';
import { CalendarUpdateEventHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { NylasCalendarEvent } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import type { Logger } from '../../../../src/logger.js';

function makeEvent(overrides: Partial<NylasCalendarEvent> & { id: string }): NylasCalendarEvent {
  return {
    title: 'Weekly sync',
    description: '',
    location: '',
    startTime: 1793628000,
    endTime: 1793628900,
    startDate: null,
    endDate: null,
    participants: [],
    conferencing: null,
    status: 'confirmed',
    calendarId: 'cal-work',
    busy: true,
    metadata: null,
    ...overrides,
  };
}

function makeCtx(input: Record<string, unknown>, opts: {
  getEvent?: ReturnType<typeof vi.fn>;
  updateEvent?: ReturnType<typeof vi.fn>;
} = {}): ToolContext {
  return {
    input,
    secret: () => { throw new Error('no secret in test'); },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    nylasCalendarClient: {
      getEvent: opts.getEvent ?? vi.fn().mockResolvedValue(makeEvent({ id: 'master', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] })),
      updateEvent: opts.updateEvent ?? vi.fn().mockResolvedValue(makeEvent({ id: 'master' })),
    } as unknown as ToolContext['nylasCalendarClient'],
    timezone: 'America/Toronto',
  } as unknown as ToolContext;
}

const UNTIL_RULE = ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z'];

describe('CalendarUpdateEventHandler -- conferencing (#2536)', () => {
  it('sends Nylas autocreate: {} and the canonical provider', async () => {
    const updateEvent = vi.fn().mockResolvedValue(makeEvent({ id: 'evt' }));
    const ctx = makeCtx(
      { calendarId: 'cal-work', eventId: 'evt', conferencing: { provider: 'Meet', autocreate: true } },
      { updateEvent },
    );

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(updateEvent.mock.calls[0]![2].conferencing).toEqual({ provider: 'Google Meet', autocreate: {} });
  });

  it('refuses Zoom auto-creation with one clean error and no Nylas call', async () => {
    const updateEvent = vi.fn();
    const ctx = makeCtx(
      { calendarId: 'cal-work', eventId: 'evt', conferencing: { provider: 'Zoom', autocreate: true } },
      { updateEvent },
    );

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('no Zoom account is connected');
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('refuses null, since no removal path exists and dropping it would report a false success', async () => {
    const updateEvent = vi.fn();
    const ctx = makeCtx(
      { calendarId: 'cal-work', eventId: 'evt', title: 'New title', conferencing: null },
      { updateEvent },
    );

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(updateEvent).not.toHaveBeenCalled();
  });
});

describe('CalendarUpdateEventHandler -- recurrence', () => {
  it('updates the rule on a series master, sending the configured timezone', async () => {
    const updateEvent = vi.fn().mockResolvedValue(makeEvent({ id: 'master', recurrence: UNTIL_RULE }));
    const ctx = makeCtx({ calendarId: 'cal-work', eventId: 'master', recurrence: UNTIL_RULE }, { updateEvent });

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(true);
    const [, eventId, changes] = updateEvent.mock.calls[0]!;
    expect(eventId).toBe('master');
    expect(changes.recurrence).toEqual(UNTIL_RULE);
    expect(changes.timezone).toBe('America/Toronto');
  });

  it('refuses a rule change aimed at one instance and points at the master', async () => {
    const getEvent = vi.fn().mockResolvedValue(makeEvent({ id: 'master_20261109T140000Z', masterEventId: 'master' }));
    const updateEvent = vi.fn();
    const ctx = makeCtx(
      { calendarId: 'cal-work', eventId: 'master_20261109T140000Z', recurrence: UNTIL_RULE },
      { getEvent, updateEvent },
    );

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("'master'");
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('sends the series start and end with a recurrence-only change, so Nylas gets a full when', async () => {
    const updateEvent = vi.fn().mockResolvedValue(makeEvent({ id: 'master' }));
    const ctx = makeCtx({ calendarId: 'cal-work', eventId: 'master', recurrence: UNTIL_RULE }, { updateEvent });

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(true);
    const changes = updateEvent.mock.calls[0]![2];
    expect(changes.start).toBe('2026-11-02T14:00:00.000Z');
    expect(changes.end).toBe('2026-11-02T14:15:00.000Z');
  });

  it('keeps a caller-supplied start and derives the end from the series duration', async () => {
    const updateEvent = vi.fn().mockResolvedValue(makeEvent({ id: 'master' }));
    const ctx = makeCtx(
      { calendarId: 'cal-work', eventId: 'master', start: '2026-11-09T14:30:00Z', recurrence: UNTIL_RULE },
      { updateEvent },
    );

    await new CalendarUpdateEventHandler().execute(ctx);

    const changes = updateEvent.mock.calls[0]![2];
    expect(changes.start).toBe('2026-11-09T14:30:00Z');
    expect(changes.end).toBe('2026-11-09T14:45:00.000Z');
  });

  it('names an unparseable start instead of failing with "Invalid time value"', async () => {
    const updateEvent = vi.fn();
    const ctx = makeCtx({ calendarId: 'cal-work', eventId: 'master', start: 'tomorrow', recurrence: UNTIL_RULE }, { updateEvent });

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/start "tomorrow" is not a valid date/);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('refuses a recurrence change on an all-day event', async () => {
    const getEvent = vi.fn().mockResolvedValue(makeEvent({ id: 'master', startTime: null, endTime: null, startDate: '2026-11-02', endDate: '2026-11-02' }));
    const updateEvent = vi.fn();
    const ctx = makeCtx({ calendarId: 'cal-work', eventId: 'master', recurrence: UNTIL_RULE }, { getEvent, updateEvent });

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('refuses EXDATE lines and points at calendar-delete-event', async () => {
    const updateEvent = vi.fn();
    const ctx = makeCtx(
      { calendarId: 'cal-work', eventId: 'master', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE:20261116T140000Z'] },
      { updateEvent },
    );

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('calendar-delete-event');
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('checks a new start against the new weekly rule', async () => {
    const updateEvent = vi.fn();
    // 2026-11-02 (Monday) 9:00 AM Toronto, against a Tuesday rule.
    const ctx = makeCtx(
      { calendarId: 'cal-work', eventId: 'master', start: '2026-11-02T14:00:00Z', end: '2026-11-02T14:15:00Z', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] },
      { updateEvent },
    );

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed recurrence without calling Nylas', async () => {
    const updateEvent = vi.fn();
    const ctx = makeCtx({ calendarId: 'cal-work', eventId: 'master', recurrence: 'weekly' }, { updateEvent });

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('edits a single instance when no rule change is asked for', async () => {
    const getEvent = vi.fn();
    const updateEvent = vi.fn().mockResolvedValue(makeEvent({ id: 'master_20261109T140000Z', masterEventId: 'master' }));
    const ctx = makeCtx({ calendarId: 'cal-work', eventId: 'master_20261109T140000Z', location: 'Office' }, { getEvent, updateEvent });

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(getEvent).not.toHaveBeenCalled();
    expect(updateEvent.mock.calls[0]![1]).toBe('master_20261109T140000Z');
  });
});

describe('CalendarUpdateEventHandler -- undeclared inputs', () => {
  it('rejects an input the manifest does not declare, naming it, without updating', async () => {
    const updateEvent = vi.fn();
    const ctx = makeCtx({ calendarId: 'cal-work', eventId: 'master', repeat: 'weekly' }, { updateEvent });

    const result = await new CalendarUpdateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("'repeat'");
    expect(updateEvent).not.toHaveBeenCalled();
  });
});
