import { describe, it, expect, vi } from 'vitest';
import { CalendarRespondToInviteHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { NylasCalendarEvent } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import { createSilentLogger } from '../../../../src/logger.js';
import { buildHoldMetadata } from '../../../../src/channels/calendar/holds.js';

const START_UNIX = 1_780_000_000;
const END_UNIX = 1_780_003_600;

function makeEvent(overrides?: Partial<NylasCalendarEvent>): NylasCalendarEvent {
  return {
    id: 'evt_invite',
    title: 'Project Delta sync',
    description: '',
    location: '',
    startTime: START_UNIX,
    endTime: END_UNIX,
    startDate: null,
    endDate: null,
    participants: [
      { email: 'principal@example.test', name: 'Principal', status: 'yes' },
      { email: 'organizer@example.test', name: 'Organizer', status: 'yes' },
    ],
    conferencing: null,
    status: 'confirmed',
    calendarId: 'cal_1',
    busy: true,
    metadata: null,
    ...overrides,
  };
}

function makeHold(id: string, startTime: number, endTime: number, ref?: { sourceRef?: string; threadRef?: string }): NylasCalendarEvent {
  return makeEvent({
    id,
    title: 'HOLD (TBC): Project Delta sync',
    startTime,
    endTime,
    participants: [],
    status: 'tentative',
    metadata: buildHoldMetadata({
      createdAtIso: '2026-06-24T12:00:00.000Z',
      subject: 'Project Delta sync',
      contactDomain: 'example.test',
      sourceRef: ref?.sourceRef ?? 'msg-negotiation',
      threadRef: ref?.threadRef ?? 'thread-negotiation',
    }),
  });
}

function makeCtx(overrides?: Partial<ToolContext>, clientOverrides?: Record<string, unknown>): ToolContext {
  const sendRsvp = vi.fn().mockResolvedValue({ requestId: 'req_1', sendIcsError: null });
  const getEvent = vi.fn().mockResolvedValue(makeEvent());
  const listEvents = vi.fn().mockResolvedValue([]);
  const deleteEvent = vi.fn().mockResolvedValue(undefined);
  return {
    input: {
      calendarId: 'cal_1',
      eventId: 'evt_invite',
      response: 'accept',
    },
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    timezone: 'UTC',
    nylasCalendarClient: {
      sendRsvp,
      getEvent,
      listEvents,
      deleteEvent,
      updateEvent: vi.fn(),
      ...clientOverrides,
    } as unknown as ToolContext['nylasCalendarClient'],
    ...overrides,
  } as ToolContext;
}

describe('CalendarRespondToInviteHandler', () => {
  it.each([
    ['accept', 'yes'],
    ['decline', 'no'],
    ['tentative', 'maybe'],
  ])('maps %s to Nylas RSVP status %s', async (response, status) => {
    const handler = new CalendarRespondToInviteHandler();
    const ctx = makeCtx({
      input: { calendarId: 'cal_1', eventId: 'evt_invite', response },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.nylasCalendarClient!.sendRsvp).toHaveBeenCalledWith('cal_1', 'evt_invite', status);
  });

  it('uses sendRsvp only and never writes a participants array through updateEvent', async () => {
    const handler = new CalendarRespondToInviteHandler();
    const updateEvent = vi.fn();
    const ctx = makeCtx(undefined, { updateEvent });

    await handler.execute(ctx);

    expect(ctx.nylasCalendarClient!.sendRsvp).toHaveBeenCalledOnce();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('releases all matching holds for the scheduling conversation when accepting', async () => {
    const handler = new CalendarRespondToInviteHandler();
    const holdOne = makeHold('hold_1', START_UNIX, END_UNIX);
    const holdTwo = makeHold('hold_2', START_UNIX + 86_400, END_UNIX + 86_400);
    const unrelatedHold = makeEvent({
      id: 'hold_other',
      title: 'HOLD (TBC): Other meeting',
      startTime: START_UNIX,
      endTime: END_UNIX,
      status: 'tentative',
      metadata: buildHoldMetadata({
        createdAtIso: '2026-06-24T12:00:00.000Z',
        subject: 'Other meeting',
        contactDomain: 'other.example',
        sourceRef: 'msg-other',
        threadRef: 'thread-other',
      }),
    });
    const deleteEvent = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      input: {
        calendarId: 'cal_1',
        eventId: 'evt_invite',
        response: 'accept',
        holdMatchCriteria: {
          subject: 'Quick Project Delta sync',
          contactDomain: 'example.test',
          threadRef: 'invite-thread-only',
        },
        holdSearchStart: '2026-06-01T00:00:00Z',
        holdSearchEnd: '2026-06-30T00:00:00Z',
      },
    }, {
      listEvents: vi.fn().mockResolvedValue([holdOne, holdTwo, unrelatedHold]),
      deleteEvent,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(deleteEvent).toHaveBeenCalledTimes(2);
    const deletedIds = deleteEvent.mock.calls.map((call: unknown[]) => call[1]);
    expect(deletedIds).toEqual(['hold_1', 'hold_2']);
    if (result.success) {
      expect((result.data as { releasedHolds: string[] }).releasedHolds).toEqual(['hold_1', 'hold_2']);
    }
  });

  it('does not release same-domain holds from a different conversation', async () => {
    const handler = new CalendarRespondToInviteHandler();
    const conversationHold = makeHold('hold_a', START_UNIX, END_UNIX);
    const otherConversationHold = makeHold('hold_b', START_UNIX, END_UNIX, {
      sourceRef: 'msg-other',
      threadRef: 'thread-other',
    });
    const deleteEvent = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      input: {
        calendarId: 'cal_1',
        eventId: 'evt_invite',
        response: 'accept',
        holdMatchCriteria: {
          subject: 'Project Delta sync',
          contactDomain: 'example.test',
        },
        holdSearchStart: '2026-06-01T00:00:00Z',
        holdSearchEnd: '2026-06-30T00:00:00Z',
      },
    }, {
      listEvents: vi.fn().mockResolvedValue([conversationHold, otherConversationHold]),
      deleteEvent,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(deleteEvent).toHaveBeenCalledTimes(1);
    expect(deleteEvent).toHaveBeenCalledWith('cal_1', 'hold_a', false);
    if (result.success) {
      expect((result.data as { releasedHolds: string[] }).releasedHolds).toEqual(['hold_a']);
    }
  });

  it('releases nothing when no conversation ref can be recovered', async () => {
    const handler = new CalendarRespondToInviteHandler();
    const orphanHold = makeEvent({
      id: 'hold_orphan',
      title: 'HOLD (TBC): Project Delta sync',
      startTime: START_UNIX,
      endTime: END_UNIX,
      status: 'tentative',
      metadata: buildHoldMetadata({
        createdAtIso: '2026-06-24T12:00:00.000Z',
        subject: 'Project Delta sync',
        contactDomain: 'example.test',
      }),
    });
    const deleteEvent = vi.fn();
    const ctx = makeCtx({
      input: {
        calendarId: 'cal_1',
        eventId: 'evt_invite',
        response: 'accept',
        holdMatchCriteria: {
          subject: 'Project Delta sync',
          contactDomain: 'example.test',
        },
        holdSearchStart: '2026-06-01T00:00:00Z',
        holdSearchEnd: '2026-06-30T00:00:00Z',
      },
    }, {
      listEvents: vi.fn().mockResolvedValue([orphanHold]),
      deleteEvent,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('does not release holds for decline responses', async () => {
    const handler = new CalendarRespondToInviteHandler();
    const deleteEvent = vi.fn();
    const ctx = makeCtx({
      input: {
        calendarId: 'cal_1',
        eventId: 'evt_invite',
        response: 'decline',
        holdMatchCriteria: { subject: 'Project Delta sync', contactDomain: 'example.test' },
      },
    }, { deleteEvent });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('returns a validation error for unknown responses', async () => {
    const handler = new CalendarRespondToInviteHandler();
    const result = await handler.execute(makeCtx({
      input: { calendarId: 'cal_1', eventId: 'evt_invite', response: 'join' },
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('accept, decline, or tentative');
    }
  });
});
