// nylas-calendar-client.test.ts — unit tests for NylasCalendarClient.
//
// Uses NylasCalendarClient.createWithSdk() to inject a stub SDK, avoiding any
// real Nylas API calls. Mirrors the vi.fn() / mockResolvedValue() patterns in
// skills/calendar/tools/calendar-list-events/handler.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { NylasCalendarClient } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import type { NylasCalendarLike } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import { createSilentLogger } from '../../../../src/logger.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a NylasCalendarClient with a partially-stubbed SDK.
 * Only the methods under test need to be provided; other methods throw.
 */
function makeClientWith(sdkPartial: Partial<NylasCalendarLike>): NylasCalendarClient {
  const sdk = sdkPartial as unknown as NylasCalendarLike;
  return NylasCalendarClient.createWithSdk(sdk, 'grant_test', createSilentLogger());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NylasCalendarClient — metadata/status/busy plumbing', () => {
  it('passes metadata/status/busy to the Nylas create request and surfaces metadata on read', async () => {
    const create = vi.fn().mockResolvedValue({
      data: {
        id: 'evt_1',
        metadata: { 'curia-hold': 'true' },
        busy: true,
        status: 'tentative',
        when: { startTime: 1000, endTime: 2000 },
      },
    });
    const client = makeClientWith({ events: { create } as unknown as NylasCalendarLike['events'] });
    const out = await client.createEvent('cal_1', {
      title: 'HOLD (TBC): coffee',
      start: '2026-06-25T14:30:00Z',
      end: '2026-06-25T15:00:00Z',
      busy: true,
      status: 'tentative',
      metadata: { 'curia-hold': 'true', 'created-at': '2026-06-24T00:00:00Z' },
    });

    // Verify all three fields were forwarded into the Nylas request body
    const body = create.mock.calls[0]![0].requestBody;
    expect(body.metadata).toEqual({ 'curia-hold': 'true', 'created-at': '2026-06-24T00:00:00Z' });
    expect(body.status).toBe('tentative');
    expect(body.busy).toBe(true);

    // Verify metadata is surfaced on the normalized output event
    expect(out.metadata).toEqual({ 'curia-hold': 'true' });
  });

  it('defaults metadata to null when the raw event omits it', async () => {
    const create = vi.fn().mockResolvedValue({
      data: {
        id: 'evt_2',
        when: { startTime: 1000, endTime: 2000 },
        // no metadata field
      },
    });
    const client = makeClientWith({ events: { create } as unknown as NylasCalendarLike['events'] });
    const out = await client.createEvent('cal_1', {
      title: 'Regular meeting',
      start: '2026-06-25T14:30:00Z',
      end: '2026-06-25T15:00:00Z',
    });

    expect(out.metadata).toBeNull();
  });

  it('does NOT include metadata/status/busy in the request body when not provided', async () => {
    const create = vi.fn().mockResolvedValue({
      data: {
        id: 'evt_3',
        when: { startTime: 1000, endTime: 2000 },
      },
    });
    const client = makeClientWith({ events: { create } as unknown as NylasCalendarLike['events'] });
    await client.createEvent('cal_1', {
      title: 'Regular meeting',
      start: '2026-06-25T14:30:00Z',
      end: '2026-06-25T15:00:00Z',
    });

    const body = create.mock.calls[0]![0].requestBody;
    // Additive-only: these keys must be absent when not supplied
    expect(body).not.toHaveProperty('metadata');
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('busy');
  });
});

describe('NylasCalendarClient — iCal UID', () => {
  it('normalizeEvent maps icalUid', async () => {
    const create = vi.fn().mockResolvedValue({
      data: { id: 'evt_u', icalUid: 'uid-123@google.com', when: { startTime: 1000, endTime: 2000 } },
    });
    const client = makeClientWith({ events: { create } as unknown as NylasCalendarLike['events'] });
    const out = await client.createEvent('cal_1', {
      title: 'x',
      start: '2026-06-25T14:30:00Z',
      end: '2026-06-25T15:00:00Z',
    });
    expect(out.icalUid).toBe('uid-123@google.com');
  });

  it('omits icalUid when the raw event has none', async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: 'evt_n', when: { startTime: 1000, endTime: 2000 } } });
    const client = makeClientWith({ events: { create } as unknown as NylasCalendarLike['events'] });
    const out = await client.createEvent('cal_1', { title: 'x', start: '2026-06-25T14:30:00Z', end: '2026-06-25T15:00:00Z' });
    expect(out).not.toHaveProperty('icalUid');
    expect(out).not.toHaveProperty('organizerEmail');
  });

  it('normalizeEvent maps the organizer address', async () => {
    const create = vi.fn().mockResolvedValue({
      data: { id: 'evt_o', organizer: { email: 'chair@board.example.org', name: 'Chair' }, when: { startTime: 1000, endTime: 2000 } },
    });
    const client = makeClientWith({ events: { create } as unknown as NylasCalendarLike['events'] });
    const out = await client.createEvent('cal_1', { title: 'x', start: '2026-06-25T14:30:00Z', end: '2026-06-25T15:00:00Z' });
    expect(out.organizerEmail).toBe('chair@board.example.org');
  });
});

describe('NylasCalendarClient — recurrence plumbing', () => {
  it('sends recurrence with start/end timezones on create and surfaces it on the result', async () => {
    const create = vi.fn().mockResolvedValue({
      data: {
        id: 'master_1',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        when: { startTime: 1000, endTime: 2000 },
      },
    });
    const client = makeClientWith({ events: { create } as unknown as NylasCalendarLike['events'] });
    const out = await client.createEvent('cal_1', {
      title: 'Weekly sync',
      start: '2026-11-02T14:00:00Z',
      end: '2026-11-02T14:15:00Z',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      timezone: 'America/Toronto',
    });

    const body = create.mock.calls[0]![0].requestBody;
    expect(body.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    expect(body.when.start_timezone).toBe('America/Toronto');
    expect(body.when.end_timezone).toBe('America/Toronto');
    expect(out.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
  });

  it('leaves recurrence and timezones out of a one-off create', async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: 'evt_1', when: { startTime: 1000, endTime: 2000 } } });
    const client = makeClientWith({ events: { create } as unknown as NylasCalendarLike['events'] });
    const out = await client.createEvent('cal_1', {
      title: 'One-off',
      start: '2026-11-02T14:00:00Z',
      end: '2026-11-02T14:15:00Z',
    });

    const body = create.mock.calls[0]![0].requestBody;
    expect(body).not.toHaveProperty('recurrence');
    expect(body.when).not.toHaveProperty('start_timezone');
    expect(out).not.toHaveProperty('recurrence');
    expect(out).not.toHaveProperty('masterEventId');
  });

  it('surfaces masterEventId and originalStartTime on recurring instances', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [{
        id: 'master_1_20261109T140000Z',
        masterEventId: 'master_1',
        originalStartTime: 1794232800,
        when: { startTime: 1794232800, endTime: 1794233700 },
        calendarId: 'cal_1',
      }],
    });
    const client = makeClientWith({ events: { list } as unknown as NylasCalendarLike['events'] });
    const [evt] = await client.listEvents('cal_1', '2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z');

    expect(evt!.masterEventId).toBe('master_1');
    expect(evt!.originalStartTime).toBe(1794232800);
  });

  it('sends recurrence on update, with timezones when the time also changes', async () => {
    const update = vi.fn().mockResolvedValue({ data: { id: 'master_1', when: { startTime: 1000, endTime: 2000 } } });
    const client = makeClientWith({ events: { update } as unknown as NylasCalendarLike['events'] });
    await client.updateEvent('cal_1', 'master_1', {
      start: '2026-11-02T14:30:00Z',
      end: '2026-11-02T14:45:00Z',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z'],
      timezone: 'America/Toronto',
    });

    const body = update.mock.calls[0]![0].requestBody;
    expect(body.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z']);
    expect(body.when.start_timezone).toBe('America/Toronto');
    expect(body.when.end_timezone).toBe('America/Toronto');
  });
});

describe('NylasCalendarClient — updateEvent attendee writes', () => {
  it('sends the full guest list as email and name and omits participant status', async () => {
    const update = vi.fn().mockResolvedValue({
      data: {
        id: 'evt_1',
        participants: [
          { email: 'a@example.test', name: 'A', status: 'noreply' },
          { email: 'b@example.test', name: 'B', status: 'yes' },
        ],
        when: { startTime: 1000, endTime: 2000 },
      },
    });
    const client = makeClientWith({ events: { update } as unknown as NylasCalendarLike['events'] });

    await client.updateEvent('cal_1', 'evt_1', {
      attendees: [
        { email: 'a@example.test', name: 'A' },
        { email: 'b@example.test', name: 'B' },
      ],
    });

    const call = update.mock.calls[0]![0] as {
      requestBody: { participants: Array<Record<string, unknown>> };
      queryParams: Record<string, unknown>;
    };
    expect(call.requestBody.participants).toEqual([
      { email: 'a@example.test', name: 'A' },
      { email: 'b@example.test', name: 'B' },
    ]);
    for (const participant of call.requestBody.participants) {
      expect(participant).not.toHaveProperty('status');
    }
    expect(call.queryParams).toEqual({ calendarId: 'cal_1' });
  });

  it('throws rather than forwarding organizer-set participant status', async () => {
    const update = vi.fn();
    const client = makeClientWith({ events: { update } as unknown as NylasCalendarLike['events'] });

    await expect(
      client.updateEvent('cal_1', 'evt_1', {
        attendees: [{ email: 'a@example.test', name: 'A', status: 'no' } as { email: string; name: string }],
      }),
    ).rejects.toThrow(/sendRsvp/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('sets notifyParticipants when notifyAttendees is provided', async () => {
    const update = vi.fn().mockResolvedValue({
      data: { id: 'evt_1', when: { startTime: 1000, endTime: 2000 } },
    });
    const client = makeClientWith({ events: { update } as unknown as NylasCalendarLike['events'] });

    await client.updateEvent('cal_1', 'evt_1', { title: 'Quiet' }, false);

    expect(update).toHaveBeenCalledWith({
      identifier: 'grant_test',
      eventId: 'evt_1',
      queryParams: { calendarId: 'cal_1', notifyParticipants: false },
      requestBody: { title: 'Quiet' },
    });
  });
});

describe('NylasCalendarClient — RSVP plumbing', () => {
  it('sends RSVP status through the Nylas sendRsvp endpoint', async () => {
    const sendRsvp = vi.fn().mockResolvedValue({
      requestId: 'req_123',
    });
    const client = makeClientWith({ events: { sendRsvp } as unknown as NylasCalendarLike['events'] });

    const result = await client.sendRsvp('cal_1', 'evt_1', 'yes');

    expect(sendRsvp).toHaveBeenCalledWith({
      identifier: 'grant_test',
      eventId: 'evt_1',
      queryParams: { calendarId: 'cal_1' },
      requestBody: { status: 'yes' },
    });
    // Pin the body shape: sendRsvp must carry ONLY { status } — never a participants
    // array or any attendee data (that would risk changing another attendee's state,
    // and is the class of request Google rejects). Fails if attendee data leaks in.
    const call = sendRsvp.mock.calls[0]![0];
    expect(Object.keys(call.requestBody)).toEqual(['status']);
    expect(call.requestBody).not.toHaveProperty('participants');
    expect(result).toEqual({ requestId: 'req_123', sendIcsError: null });
  });

  it('fetches and normalizes one event by id', async () => {
    const find = vi.fn().mockResolvedValue({
      data: {
        id: 'evt_1',
        title: 'Invite',
        participants: [{ email: 'principal@example.test', status: 'yes' }],
        when: { startTime: 1_780_000_000, endTime: 1_780_003_600 },
        calendarId: 'cal_1',
      },
    });
    const client = makeClientWith({ events: { find } as unknown as NylasCalendarLike['events'] });

    const event = await client.getEvent('cal_1', 'evt_1');

    expect(find).toHaveBeenCalledWith({
      identifier: 'grant_test',
      eventId: 'evt_1',
      queryParams: { calendarId: 'cal_1' },
    });
    expect(event.id).toBe('evt_1');
    expect(event.participants[0]!.status).toBe('yes');
  });
});

describe('NylasCalendarClient — free/busy plumbing', () => {
  it('queries the real Nylas calendars.getFreeBusy endpoint and maps busy slots', async () => {
    const getFreeBusy = vi.fn().mockResolvedValue({
      data: [
        {
          email: 'joseph@example.test',
          timeSlots: [{ startTime: 1_780_000_000, endTime: 1_780_003_600, status: 'busy' }],
          object: 'free_busy',
        },
      ],
    });
    // Only stub `calendars.getFreeBusy` — the real Nylas v8 SDK has no
    // `calendars_free_busy` resource, so the previous implementation crashed here.
    const client = makeClientWith({
      calendars: { getFreeBusy } as unknown as NylasCalendarLike['calendars'],
    });

    const result = await client.getFreeBusy(
      ['joseph@example.test'],
      '2026-06-29T00:00:00-04:00',
      '2026-06-30T00:00:00-04:00',
    );

    expect(getFreeBusy).toHaveBeenCalledWith({
      identifier: 'grant_test',
      requestBody: {
        start_time: Math.floor(new Date('2026-06-29T00:00:00-04:00').getTime() / 1000),
        end_time: Math.floor(new Date('2026-06-30T00:00:00-04:00').getTime() / 1000),
        emails: ['joseph@example.test'],
      },
    });
    expect(result).toEqual([
      {
        email: 'joseph@example.test',
        timeSlots: [{ startTime: 1_780_000_000, endTime: 1_780_003_600, status: 'busy' }],
      },
    ]);
  });

  it('throws when a calendar returns a free/busy error entry instead of treating it as free', async () => {
    // Nylas getFreeBusy returns a mixed array: success entries (object: "free_busy",
    // with timeSlots) and error entries (object: "error", with an error string and no
    // timeSlots). An error entry must NOT be silently mapped to an empty (= free) slot
    // list, or a conflict check would read an unreadable calendar as wide open and
    // double-book the principal.
    const getFreeBusy = vi.fn().mockResolvedValue({
      data: [
        { email: 'joseph@example.test', error: 'permission denied', object: 'error' },
      ],
    });
    const client = makeClientWith({
      calendars: { getFreeBusy } as unknown as NylasCalendarLike['calendars'],
    });

    let caught: unknown;
    try {
      await client.getFreeBusy(
        ['joseph@example.test'],
        '2026-06-29T00:00:00-04:00',
        '2026-06-30T00:00:00-04:00',
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/free.?busy/i);
    // The thrown message must not leak the mailbox identifier (PII).
    expect((caught as Error).message).not.toContain('joseph@example.test');
  });
});

describe('NylasCalendarClient.listEvents — expandRecurring (#2475)', () => {
  function sdkWithList() {
    const list = vi.fn().mockResolvedValue({ data: [] });
    return { list, client: makeClientWith({ events: { list } as unknown as NylasCalendarLike['events'] }) };
  }

  it('asks Nylas for every occurrence when expandRecurring is set', async () => {
    const { list, client } = sdkWithList();
    await client.listEvents('cal_1', '2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z', { expandRecurring: true });
    expect((list.mock.calls[0]![0] as { queryParams: Record<string, unknown> }).queryParams).toMatchObject({ expandRecurring: true });
  });

  it('leaves the query unchanged without it', async () => {
    const { list, client } = sdkWithList();
    await client.listEvents('cal_1', '2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z');
    expect(list.mock.calls[0]![0] as { queryParams: Record<string, unknown> }).not.toHaveProperty('queryParams.expandRecurring');
  });
});
