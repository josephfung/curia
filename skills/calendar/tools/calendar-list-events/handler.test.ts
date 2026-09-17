// handler.test.ts — unit tests for calendar-list-events skill.

import { describe, it, expect, vi } from 'vitest';
import { CalendarListEventsHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';
import { NylasCalendarClient } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import type { NylasCalendarLike } from '../../../../src/channels/calendar/nylas-calendar-client.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    input: {
      timeMin: '2026-05-26T00:00:00Z',
      timeMax: '2026-05-26T23:59:59Z',
    },
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    nylasCalendarClient: {
      listEvents: vi.fn().mockResolvedValue([]),
    } as unknown as ToolContext['nylasCalendarClient'],
    ...overrides,
  } as ToolContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CalendarListEventsHandler — system caller guard', () => {
  it('returns a clear error when ctx.caller.contactId is "system" and no calendarId is provided', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn().mockRejectedValue(
        new Error('invalid input syntax for type uuid: "system"'),
      ),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'system', role: null, channel: 'internal' },
      contactService,
    }));

    expect(result.success).toBe(false);
    // Should surface an actionable error, not a raw Postgres UUID parse error
    expect((result as { error: string }).error).toContain('calendarId');
    // contactService should never have been called — the guard fires before the DB hit
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalled();
  });

  it('returns a clear error when ctx.caller.contactId is "primary-user" and no calendarId is provided', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn(),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      contactService,
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('calendarId');
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalled();
  });

  it('does NOT fire the guard for a valid UUID contactId — proceeds to getCalendarsForContact', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-work' },
      ]),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', role: 'ceo', channel: 'signal' },
      contactService,
      nylasCalendarClient: {
        listEvents: vi.fn().mockResolvedValue([]),
      } as unknown as ToolContext['nylasCalendarClient'],
    }));

    // Guard must not have fired — contactService was called with the UUID
    expect(contactService!.getCalendarsForContact).toHaveBeenCalledWith('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    // Result: no events but success (the calendar exists, range is empty)
    expect(result.success).toBe(true);
  });
});

describe('CalendarListEventsHandler — explicit contactId input', () => {
  it('uses explicit contactId input to look up calendars, bypassing caller identity', async () => {
    // Simulates a scheduled agent passing ${principal_contact_id} explicitly
    const handler = new CalendarListEventsHandler();
    const principalId = 'deadbeef-0000-0000-0000-000000000001';
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'joseph@josephfung.ca' },
      ]),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      input: {
        contactId: principalId,
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      // System caller — would normally be rejected without an explicit contactId
      caller: { contactId: 'system', role: null, channel: 'internal' },
      taskMetadata: { originator: { systemRole: 'system' } },
      contactService,
      nylasCalendarClient: {
        listEvents: vi.fn().mockResolvedValue([]),
      } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(contactService!.getCalendarsForContact).toHaveBeenCalledWith(principalId);
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID contactId input', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn(),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      input: {
        contactId: 'joseph',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      caller: { contactId: 'system', role: null, channel: 'internal' },
      taskMetadata: { originator: { systemRole: 'system' } },
      contactService,
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('UUID');
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalled();
  });

  // #1800: the social-media agent read `${principal_contact_id}` out of this tool's own
  // description and passed it through verbatim, 10 times over eight weeks. "must be a
  // UUID" reads as a malformed ID and invites another guess; naming the template fault
  // tells the model where the value actually comes from.
  it('rejects a literal ${...} template token with a message naming the real fault', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn(),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      input: {
        contactId: '${principal_contact_id}',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      caller: { contactId: 'system', role: null, channel: 'internal' },
      taskMetadata: { originator: { systemRole: 'system' } },
      contactService,
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Unresolved template placeholder');
    expect((result as { error: string }).error).toContain('system prompt');
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalled();
  });

  it('names the template fault even for a caller not allowed to override contactId', async () => {
    // A non-system, non-principal caller passing the token is not attempting to read
    // someone else's calendar — it is a prompt that never got interpolated. Answering
    // "override is not allowed" would send the model hunting for permission it already
    // has, which is what prod showed it doing (12 such failures).
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn(),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      input: {
        contactId: '${principal_contact_id}',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      caller: { contactId: 'deadbeef-0000-0000-0000-000000000009', role: null, channel: 'internal' },
      taskMetadata: { originator: { systemRole: 'agent' } },
      contactService,
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Unresolved template placeholder');
    expect((result as { error: string }).error).not.toContain('not allowed');
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalled();
  });

  it('explicit contactId takes precedence over caller contactId when caller is principal', async () => {
    const handler = new CalendarListEventsHandler();
    const principalId = 'deadbeef-0000-0000-0000-000000000001';
    const callerId = 'cafebabe-0000-0000-0000-000000000002';
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-principal' },
      ]),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      input: {
        contactId: principalId,
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      caller: { contactId: callerId, role: 'ceo', channel: 'signal' },
      taskMetadata: { originator: { systemRole: 'principal' } },
      contactService,
      nylasCalendarClient: {
        listEvents: vi.fn().mockResolvedValue([]),
      } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(contactService!.getCalendarsForContact).toHaveBeenCalledWith(principalId);
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalledWith(callerId);
    expect(result.success).toBe(true);
  });

  it('rejects contactId override for non-principal, non-system callers', async () => {
    const handler = new CalendarListEventsHandler();
    const someContactId = 'deadbeef-0000-0000-0000-000000000001';
    const callerContactId = 'cafebabe-0000-0000-0000-000000000002';
    const contactService = {
      getCalendarsForContact: vi.fn(),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      input: {
        contactId: someContactId,
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      // Regular UUID caller with no ceo role — should be blocked
      caller: { contactId: callerContactId, role: null, channel: 'signal' },
      contactService,
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('not allowed');
    expect(contactService!.getCalendarsForContact).not.toHaveBeenCalled();
  });

  it('surfaces a clear error when getCalendarsForContact throws in the contactId path', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn().mockRejectedValue(new Error('connection terminated unexpectedly')),
    } as unknown as ToolContext['contactService'];

    const result = await handler.execute(makeCtx({
      input: {
        contactId: 'deadbeef-0000-0000-0000-000000000001',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      caller: { contactId: 'system', role: null, channel: 'internal' },
      taskMetadata: { originator: { systemRole: 'system' } },
      contactService,
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to list events');
  });
});

describe('CalendarListEventsHandler — auth-class all-fail (#1561)', () => {
  it('returns AUTH_FAILURE when every calendar fails with statusCode 401/403', async () => {
    const handler = new CalendarListEventsHandler();
    const authErr = Object.assign(new Error('Request failed with status code 401'), { statusCode: 401 });
    const listEvents = vi.fn().mockRejectedValue(authErr);
    const result = await handler.execute(makeCtx({
      input: {
        calendarId: 'cal-primary',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorType).toBe('AUTH_FAILURE');
      expect(result.error).toMatch(/authorization|grant|Reconnect/i);
      expect(result.error).toContain('cal-primary');
    }
  });

  it('keeps a generic error for non-auth total failures', async () => {
    const handler = new CalendarListEventsHandler();
    const listEvents = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await handler.execute(makeCtx({
      input: {
        calendarId: 'cal-primary',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorType).toBeUndefined();
      expect(result.error).toContain('Failed to list events from any calendar');
    }
  });

  it('returns success with warnings on partial calendar failure', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-ok' },
        { nylasCalendarId: 'cal-bad' },
      ]),
    } as unknown as ToolContext['contactService'];
    const listEvents = vi.fn()
      .mockResolvedValueOnce([{
        id: 'e1', title: 'Standup', description: '', startTime: 1_700_000_000, endTime: 1_700_003_600,
        startDate: null, endDate: null, attendees: [], location: null, htmlLink: null, status: 'confirmed',
      }])
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { statusCode: 403 }));

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', role: 'ceo', channel: 'signal' },
      contactService,
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { count: number; warnings?: string[] };
      expect(data.count).toBe(1);
      expect(data.warnings?.[0]).toContain('cal-bad');
    }
  });
});

// The agent looped on `maxResults: 250` in prod because the skill flattened the
// upstream "limit must be lower than or equal to 200" away, leaving it nothing to
// correct against (#1798).
describe('CalendarListEventsHandler — failure reasons reach the caller', () => {
  it('includes the upstream message in the total-failure error', async () => {
    const handler = new CalendarListEventsHandler();
    const listEvents = vi.fn().mockRejectedValue(
      Object.assign(new Error('limit must be lower than or equal to 200'), { statusCode: 400 }),
    );

    const result = await handler.execute(makeCtx({
      input: {
        calendarId: 'joseph@josephfung.ca',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
        maxResults: 250,
      },
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('1 failed: joseph@josephfung.ca: limit must be lower than or equal to 200');
    }
  });

  it('names each failing calendar with its own reason', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-a' },
        { nylasCalendarId: 'cal-b' },
      ]),
    } as unknown as ToolContext['contactService'];
    const listEvents = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('calendar not found'));

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', role: 'ceo', channel: 'signal' },
      contactService,
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cal-a: timeout');
      expect(result.error).toContain('cal-b: calendar not found');
    }
  });

  it('includes the reason in the partial-failure warning too', async () => {
    const handler = new CalendarListEventsHandler();
    const contactService = {
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-ok' },
        { nylasCalendarId: 'cal-bad' },
      ]),
    } as unknown as ToolContext['contactService'];
    const listEvents = vi.fn()
      .mockResolvedValueOnce([{
        id: 'e1', title: 'Standup', description: '', startTime: 1_700_000_000, endTime: 1_700_003_600,
        startDate: null, endDate: null, attendees: [], location: null, htmlLink: null, status: 'confirmed',
      }])
      .mockRejectedValueOnce(new Error('upstream exploded'));

    const result = await handler.execute(makeCtx({
      caller: { contactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', role: 'ceo', channel: 'signal' },
      contactService,
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { warnings?: string[] };
      expect(data.warnings?.[0]).toContain('cal-bad: upstream exploded');
    }
  });

  it('keeps the dedicated auth message when every calendar fails on auth', async () => {
    const handler = new CalendarListEventsHandler();
    const listEvents = vi.fn().mockRejectedValue(
      Object.assign(new Error('Forbidden'), { statusCode: 403 }),
    );

    const result = await handler.execute(makeCtx({
      input: {
        calendarId: 'cal-primary',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorType).toBe('AUTH_FAILURE');
      expect(result.error).toMatch(/Reconnect the grant/);
    }
  });

  it('renders a non-Error rejection without "[object Object]"', async () => {
    const handler = new CalendarListEventsHandler();
    const listEvents = vi.fn().mockRejectedValue({ message: 'plain object failure' });

    const result = await handler.execute(makeCtx({
      input: {
        calendarId: 'cal-primary',
        timeMin: '2026-05-26T00:00:00Z',
        timeMax: '2026-05-26T23:59:59Z',
      },
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cal-primary: plain object failure');
      expect(result.error).not.toContain('[object Object]');
    }
  });

  it('passes maxResults through as a total for the client to page for', async () => {
    const handler = new CalendarListEventsHandler();
    const listEvents = vi.fn().mockResolvedValue([]);

    await handler.execute(makeCtx({
      input: {
        calendarId: 'cal-primary',
        timeMin: '2026-05-01T00:00:00Z',
        timeMax: '2026-06-01T00:00:00Z',
        maxResults: 250,
      },
      nylasCalendarClient: { listEvents } as unknown as ToolContext['nylasCalendarClient'],
    }));

    expect(listEvents).toHaveBeenCalledWith(
      'cal-primary', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z', { limit: 250 },
    );
  });
});

// End-to-end over the real client (only the Nylas SDK is mocked): the exact prod
// call that failed — maxResults: 250 across a window holding more than 200 events.
describe('CalendarListEventsHandler — maxResults > 200 end to end', () => {
  function rawPage(from: number, count: number): { data: unknown[] } {
    return {
      data: Array.from({ length: count }, (_, i) => ({
        id: `evt-${from + i}`,
        title: `Event ${from + i}`,
        calendarId: 'cal-primary',
        status: 'confirmed',
        busy: true,
        when: { startTime: 1_700_000_000 + from + i, endTime: 1_700_003_600 + from + i, object: 'timespan' },
      })),
    };
  }

  it('returns 250 events over two pages, sending no Nylas limit above 200', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ ...rawPage(0, 200), nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ ...rawPage(200, 50) });
    const sdk = {
      calendars: { list: vi.fn(), find: vi.fn(), getFreeBusy: vi.fn() },
      events: { list, find: vi.fn(), create: vi.fn(), update: vi.fn(), sendRsvp: vi.fn(), destroy: vi.fn() },
    } as unknown as NylasCalendarLike;

    const handler = new CalendarListEventsHandler();
    const result = await handler.execute(makeCtx({
      input: {
        calendarId: 'cal-primary',
        timeMin: '2026-09-01T00:00:00Z',
        timeMax: '2026-09-30T00:00:00Z',
        maxResults: 250,
      },
      nylasCalendarClient: NylasCalendarClient.createWithSdk(sdk, 'grant-123', createSilentLogger()),
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { count: number }).count).toBe(250);
    }
    const limits = list.mock.calls.map((c) => (c[0] as { queryParams: { limit: number } }).queryParams.limit);
    expect(limits).toEqual([200, 50]);
    expect(limits.every((l) => l <= 200)).toBe(true);
  });
});
