// skills/calendar-create-event/handler.test.ts
//
// Unit tests for the calendar-create-event skill handler.
// Covers:
//   - Self-release: after a successful booking, overlapping curia-hold events are deleted
//   - Self-release robustness: if listEvents throws, the booking still returns success:true
//   - Only curia-hold events are deleted (real meetings and the new event itself are left alone)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarCreateEventHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { NylasCalendarEvent } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import type { Logger } from '../../../../src/logger.js';
import { CURIA_HOLD_KEY } from '../../../../src/channels/calendar/holds.js';
import { singleMailboxRouter } from '../../../_shared/calendar-router-test-helpers.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const START_ISO = '2026-06-25T14:00:00Z';
const END_ISO = '2026-06-25T15:00:00Z';
// Unix seconds for the booked slot
const START_UNIX = Math.floor(new Date(START_ISO).getTime() / 1000);
const END_UNIX = Math.floor(new Date(END_ISO).getTime() / 1000);

/** Build a NylasCalendarEvent. By default, looks like a freshly created real event. */
function makeEvent(overrides: Partial<NylasCalendarEvent> & { id: string }): NylasCalendarEvent {
  return {
    title: 'Test meeting',
    description: '',
    location: '',
    startTime: START_UNIX,
    endTime: END_UNIX,
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

/** A freshly created real event (returned from createEvent). */
const CREATED_EVENT = makeEvent({ id: 'new-event-id', metadata: null });

/** An overlapping curia-hold event — should be deleted. */
const OVERLAPPING_HOLD = makeEvent({
  id: 'hold-event-id',
  title: 'HOLD (TBC): quarterly sync',
  status: 'tentative',
  // Overlaps the booked slot: same time window
  startTime: START_UNIX,
  endTime: END_UNIX,
  metadata: { [CURIA_HOLD_KEY]: 'true', 'created-at': new Date().toISOString() },
});

/** An overlapping real meeting (no curia-hold metadata) — must NOT be deleted. */
const OVERLAPPING_REAL_MEETING = makeEvent({
  id: 'real-meeting-id',
  title: 'Other real meeting',
  startTime: START_UNIX,
  endTime: END_UNIX,
  metadata: null,
});

/** Build a minimal ToolContext with configurable mocks. */
function makeCtx(opts: {
  createEvent?: ReturnType<typeof vi.fn>;
  listEvents?: ReturnType<typeof vi.fn>;
  deleteEvent?: ReturnType<typeof vi.fn>;
}): ToolContext {
  const createEvent = opts.createEvent ?? vi.fn().mockResolvedValue(CREATED_EVENT);
  const listEvents = opts.listEvents ?? vi.fn().mockResolvedValue([]);
  const deleteEvent = opts.deleteEvent ?? vi.fn().mockResolvedValue(undefined);

  return {
    input: {
      calendarId: 'cal-work',
      title: 'Quarterly sync',
      start: START_ISO,
      end: END_ISO,
    },
    secret: () => { throw new Error('no secret in test'); },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    calendarRouter: singleMailboxRouter({
      createEvent,
      listEvents,
      deleteEvent,
    }),
    timezone: 'America/Toronto',
  } as unknown as ToolContext;
}

/** A second overlapping curia-hold — used in partial-failure tests. */
const OVERLAPPING_HOLD_2 = makeEvent({
  id: 'hold-event-id-2',
  title: 'HOLD (TBC): team standup',
  status: 'tentative',
  startTime: START_UNIX,
  endTime: END_UNIX,
  metadata: { [CURIA_HOLD_KEY]: 'true', 'created-at': new Date().toISOString() },
});

// ---------------------------------------------------------------------------
// Self-release tests
// ---------------------------------------------------------------------------

describe('CalendarCreateEventHandler -- self-release holds', () => {
  let handler: CalendarCreateEventHandler;
  beforeEach(() => { handler = new CalendarCreateEventHandler(); });

  it('deletes only the overlapping hold — skips the new event and the real meeting', async () => {
    const deleteEvent = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      listEvents: vi.fn().mockResolvedValue([
        OVERLAPPING_HOLD,       // should be deleted
        OVERLAPPING_REAL_MEETING, // no curia-hold metadata — must NOT be deleted
        CREATED_EVENT,          // the just-created event (same id) — must NOT be deleted
      ]),
      deleteEvent,
    });

    const result = await handler.execute(ctx);

    // Booking must succeed regardless
    expect(result.success).toBe(true);

    // Only the hold is deleted — exactly once, with notifyAttendees=false
    expect(deleteEvent).toHaveBeenCalledTimes(1);
    expect(deleteEvent).toHaveBeenCalledWith('cal-work', 'hold-event-id');

    // The real meeting and the new event are never deleted
    const deletedIds = deleteEvent.mock.calls.map((c: unknown[]) => c[1]);
    expect(deletedIds).not.toContain('real-meeting-id');
    expect(deletedIds).not.toContain('new-event-id');
  });

  it('does not release an overlapping hold that has attendees', async () => {
    const deleteEvent = vi.fn().mockResolvedValue(undefined);
    const holdWithGuest = { ...OVERLAPPING_HOLD, participants: [{ email: 'guest@example.test', name: 'Guest', status: 'noreply' }] };
    const ctx = makeCtx({
      listEvents: vi.fn().mockResolvedValue([CREATED_EVENT, holdWithGuest]),
      deleteEvent,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(deleteEvent).not.toHaveBeenCalled();
    if (result.success) {
      const data = result.data as { warnings?: string[] };
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings?.[0]).toContain('hold-event-id');
    }
  });

  it('returns success:true and does NOT call deleteEvent when listEvents throws (self-release failure must not fail booking)', async () => {
    const deleteEvent = vi.fn();
    const ctx = makeCtx({
      listEvents: vi.fn().mockRejectedValue(new Error('Nylas API unavailable')),
      deleteEvent,
    });

    const result = await handler.execute(ctx);

    // Booking must still succeed — the event was already created
    expect(result.success).toBe(true);
    // No deletion attempts because listEvents blew up before we could iterate
    expect(deleteEvent).not.toHaveBeenCalled();
    // Warn log should be emitted so we know self-release failed
    expect((ctx.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('when the FIRST deleteEvent rejects, the SECOND hold is still deleted and booking returns success', async () => {
    // HOLD_1 (hold-event-id) → first in iteration order; delete will reject
    // HOLD_2 (hold-event-id-2) → second; delete must still be attempted and succeed
    const deleteEvent = vi.fn().mockImplementation(
      (_calId: string, eventId: string) => {
        if (eventId === OVERLAPPING_HOLD.id) {
          return Promise.reject(new Error('Nylas 500: transient error'));
        }
        return Promise.resolve();
      },
    );
    const ctx = makeCtx({
      listEvents: vi.fn().mockResolvedValue([
        OVERLAPPING_HOLD,   // delete will fail
        OVERLAPPING_HOLD_2, // delete must succeed despite previous failure
      ]),
      deleteEvent,
    });

    const result = await handler.execute(ctx);

    // Booking still succeeds — self-release failure must never fail the booking
    expect(result.success).toBe(true);

    // deleteEvent was attempted for BOTH holds
    expect(deleteEvent).toHaveBeenCalledTimes(2);
    const deletedIds = deleteEvent.mock.calls.map((c: unknown[]) => c[1]);
    expect(deletedIds).toContain(OVERLAPPING_HOLD.id);
    expect(deletedIds).toContain(OVERLAPPING_HOLD_2.id);

    // Warn log emitted for the per-event failure
    expect((ctx.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Existing behaviour — input validation and happy path
// ---------------------------------------------------------------------------

describe('CalendarCreateEventHandler -- input validation', () => {
  let handler: CalendarCreateEventHandler;
  beforeEach(() => { handler = new CalendarCreateEventHandler(); });

  it('returns success:false when the calendar router is missing', async () => {
    const ctx = makeCtx({});
    ctx.calendarRouter = undefined;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
  });

  it('returns success:false when calendarId is missing', async () => {
    const ctx = makeCtx({});
    ctx.input = { title: 'Test', start: START_ISO, end: END_ISO };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('calendarId');
    }
  });

  it('returns success:false when title is missing', async () => {
    const ctx = makeCtx({});
    ctx.input = { calendarId: 'cal-work', start: START_ISO, end: END_ISO };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('title');
    }
  });

  it('returns success:false when end is not after start', async () => {
    const ctx = makeCtx({});
    ctx.input = { calendarId: 'cal-work', title: 'Test', start: END_ISO, end: START_ISO };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('end');
    }
  });
});

describe('CalendarCreateEventHandler -- happy path', () => {
  let handler: CalendarCreateEventHandler;
  beforeEach(() => { handler = new CalendarCreateEventHandler(); });

  it('returns success:true with event data when createEvent succeeds', async () => {
    const ctx = makeCtx({});

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      const event = data.event as Record<string, unknown>;
      expect(event.id).toBe('new-event-id');
    }
  });

  it('returns success:false when createEvent throws', async () => {
    const ctx = makeCtx({
      createEvent: vi.fn().mockRejectedValue(new Error('Nylas 500')),
    });

    const result = await handler.execute(ctx);

    // createEvent failure IS fatal for the booking — it returns success:false
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recurring events (#2385)
// ---------------------------------------------------------------------------

describe('CalendarCreateEventHandler -- conferencing (#2536)', () => {
  function conferencingCtx(conferencing: unknown, createEvent: ReturnType<typeof vi.fn>): ToolContext {
    const ctx = makeCtx({ createEvent });
    return { ...ctx, input: { ...ctx.input, conferencing } } as ToolContext;
  }

  it('sends Nylas autocreate: {} when asked for a Google Meet link', async () => {
    const createEvent = vi.fn().mockResolvedValue(CREATED_EVENT);

    const result = await new CalendarCreateEventHandler().execute(
      conferencingCtx({ provider: 'Google Meet', autocreate: true }, createEvent),
    );

    expect(result.success).toBe(true);
    expect(createEvent.mock.calls[0]![1].conferencing).toEqual({ provider: 'Google Meet', autocreate: {} });
  });

  it('refuses Zoom auto-creation with one clean error and no Nylas call', async () => {
    const createEvent = vi.fn();

    const result = await new CalendarCreateEventHandler().execute(
      conferencingCtx({ provider: 'Zoom', autocreate: true }, createEvent),
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('no Zoom account is connected');
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('attaches an existing Zoom link', async () => {
    const createEvent = vi.fn().mockResolvedValue(CREATED_EVENT);
    const details = { url: 'https://zoom.example/j/123' };

    const result = await new CalendarCreateEventHandler().execute(
      conferencingCtx({ provider: 'Zoom', details }, createEvent),
    );

    expect(result.success).toBe(true);
    expect(createEvent.mock.calls[0]![1].conferencing).toEqual({ provider: 'Zoom Meeting', details });
  });

  it('creates the event without conferencing when the optional field is null', async () => {
    const createEvent = vi.fn().mockResolvedValue(CREATED_EVENT);

    const result = await new CalendarCreateEventHandler().execute(conferencingCtx(null, createEvent));

    expect(result.success).toBe(true);
    expect(createEvent.mock.calls[0]![1].conferencing).toBeUndefined();
  });
});

describe('CalendarCreateEventHandler -- recurrence', () => {
  let handler: CalendarCreateEventHandler;
  beforeEach(() => { handler = new CalendarCreateEventHandler(); });

  // 2026-11-02 is a Monday; 14:00Z is 9:00 AM in Toronto.
  const MONDAY = { calendarId: 'cal-work', title: 'Weekly sync', start: '2026-11-02T14:00:00Z', end: '2026-11-02T14:15:00Z' };

  it('passes recurrence and the configured timezone to createEvent', async () => {
    const createEvent = vi.fn().mockResolvedValue(makeEvent({ id: 'master', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] }));
    const ctx = makeCtx({ createEvent });
    ctx.input = { ...MONDAY, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const sent = createEvent.mock.calls[0]![1];
    expect(sent.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    expect(sent.timezone).toBe('America/Toronto');
  });

  it('rejects malformed recurrence without calling Nylas', async () => {
    const createEvent = vi.fn();
    const ctx = makeCtx({ createEvent });
    ctx.input = { ...MONDAY, recurrence: ['FREQ=WEEKLY;BYDAY=MO'] };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('rejects a start that is off the weekly pattern', async () => {
    const createEvent = vi.fn();
    const ctx = makeCtx({ createEvent });
    ctx.input = { ...MONDAY, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('refuses a recurring event when no timezone is configured', async () => {
    const createEvent = vi.fn();
    const ctx = makeCtx({ createEvent });
    ctx.input = { ...MONDAY, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] };
    (ctx as { timezone?: string }).timezone = undefined;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe('CalendarCreateEventHandler -- undeclared inputs', () => {
  it('rejects an input the manifest does not declare, naming it, without creating anything', async () => {
    const createEvent = vi.fn();
    const ctx = makeCtx({ createEvent });
    ctx.input = { calendarId: 'cal-work', title: 'Sync', start: START_ISO, end: END_ISO, repeat: 'weekly' };

    const result = await new CalendarCreateEventHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("'repeat'");
    expect(createEvent).not.toHaveBeenCalled();
  });
});
