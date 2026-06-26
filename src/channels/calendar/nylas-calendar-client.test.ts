// nylas-calendar-client.test.ts — unit tests for NylasCalendarClient.
//
// Uses NylasCalendarClient.createWithSdk() to inject a stub SDK, avoiding any
// real Nylas API calls. Mirrors the vi.fn() / mockResolvedValue() patterns in
// skills/calendar-list-events/handler.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { NylasCalendarClient } from './nylas-calendar-client.js';
import type { NylasCalendarLike } from './nylas-calendar-client.js';
import { createSilentLogger } from '../../logger.js';

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
      queryParams: { calendar_id: 'cal_1' },
      requestBody: { status: 'yes' },
    });
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
      queryParams: { calendar_id: 'cal_1' },
    });
    expect(event.id).toBe('evt_1');
    expect(event.participants[0]!.status).toBe('yes');
  });
});
