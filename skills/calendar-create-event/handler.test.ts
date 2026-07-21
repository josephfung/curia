// skills/calendar-create-event/handler.test.ts
//
// Unit tests for the calendar-create-event skill handler.
// Covers:
//   - Self-release: after a successful booking, overlapping curia-hold events are deleted
//   - Self-release robustness: if listEvents throws, the booking still returns success:true
//   - Only curia-hold events are deleted (real meetings and the new event itself are left alone)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalendarCreateEventHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { NylasCalendarEvent } from '../../src/channels/calendar/nylas-calendar-client.js';
import type { Logger } from '../../src/logger.js';
import { CURIA_HOLD_KEY } from '../../src/channels/calendar/holds.js';

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
    nylasCalendarClient: {
      createEvent,
      listEvents,
      deleteEvent,
    } as unknown as ToolContext['nylasCalendarClient'],
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
    expect(deleteEvent).toHaveBeenCalledWith('cal-work', 'hold-event-id', false);

    // The real meeting and the new event are never deleted
    const deletedIds = deleteEvent.mock.calls.map((c: unknown[]) => c[1]);
    expect(deletedIds).not.toContain('real-meeting-id');
    expect(deletedIds).not.toContain('new-event-id');
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

  it('returns success:false when nylasCalendarClient is missing', async () => {
    const ctx = makeCtx({});
    ctx.nylasCalendarClient = undefined;

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
