// Availability across every calendar of the principal (#2475, D7, Task 33): find-free-time and
// check-conflicts read each connected account's home calendar as events, report partial and
// removed calendars, and let treat_as_free events (the cleaner's visit) stop blocking.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { ToolContext, ToolResult } from '../../../src/skills/types.js';
import {
  calendarMailbox,
  routerFixture,
  singleMailboxRouter,
  TEST_PRINCIPAL_CONTACT_ID,
  type RouterFixture,
} from '../../../skills/_shared/calendar-router-test-helpers.js';
import { CalendarCheckConflictsHandler } from '../../../skills/calendar/tools/calendar-check-conflicts/handler.js';
import { CalendarFindFreeTimeHandler } from '../../../skills/calendar/tools/calendar-find-free-time/handler.js';
import { buildHoldMetadata } from '../../../src/channels/calendar/holds.js';
import { LIST_EVENTS_MAX_TOTAL, type NylasCalendarEvent } from '../../../src/channels/calendar/nylas-calendar-client.js';

const logger = pino({ level: 'silent' });
const WORK_HOME = 'ceo@work.example.com';
const PERSONAL_HOME = 'ceo@gmail.com';
const T0 = '2026-11-20T15:00:00Z';
const T1 = '2026-11-20T18:00:00Z';
const at = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

function evt(id: string, title: string, start: string, end: string, extra: Partial<NylasCalendarEvent> = {}): NylasCalendarEvent {
  return {
    id, title, description: '', location: '', startTime: at(start), endTime: at(end),
    startDate: null, endDate: null, participants: [], conferencing: null, status: 'confirmed',
    calendarId: 'x', busy: true, metadata: null, ...extra,
  };
}

/** A stub client whose free/busy is derived from its events (busy, not cancelled, not declined), like Google's. */
function client(events: NylasCalendarEvent[] = []) {
  return {
    listCalendars: vi.fn().mockResolvedValue([]),
    listEvents: vi.fn().mockResolvedValue(events),
    getFreeBusy: vi.fn().mockImplementation(async (ids: string[]) =>
      ids.map((email) => ({
        email,
        timeSlots: events
          .filter((e) => e.busy && e.status !== 'cancelled' && e.startTime !== null && !e.participants.some((p) => p.status === 'no'))
          .map((e) => ({ startTime: e.startTime!, endTime: e.endTime!, status: 'busy' })),
      }))),
  };
}

const work = calendarMailbox('work', 'Work', WORK_HOME, true);
const personal = calendarMailbox('personal', 'Personal', PERSONAL_HOME);

function twoAccounts(workEvents: NylasCalendarEvent[], personalEvents: NylasCalendarEvent[], extra: Partial<RouterFixture> = {}) {
  const clients = { work: client(workEvents), personal: client(personalEvents) };
  const router = routerFixture({
    mailboxes: [work, personal],
    clients,
    principalCalendars: [
      { nylasCalendarId: WORK_HOME, isPrimary: true, principalMailboxId: 'work' },
      { nylasCalendarId: PERSONAL_HOME, isPrimary: true, principalMailboxId: 'personal' },
    ],
    ...extra,
  });
  return { clients, router };
}

function ctx(router: ToolContext['calendarRouter'], input: Record<string, unknown>): ToolContext {
  return {
    toolName: 'calendar-test', toolVersion: '0.0.0', input, log: logger, timezone: 'UTC',
    secret: () => { throw new Error('no secrets'); },
    calendarRouter: router,
    contactService: {
      resolveCalendar: vi.fn().mockResolvedValue(null),
      getContact: vi.fn().mockResolvedValue(null),
    } as never,
  };
}

type FreeData = {
  freeWindows: Array<{ start: string; end: string }>;
  blocking: Array<{ eventId: string | null; title: string | null; calendar_label: string; start: string; end: string }>;
  treated_as_free: Array<{ eventId: string; title: string; calendar_label: string }>;
  treat_as_free_unmatched?: string[];
  partial?: Array<{ mailbox_label: string; error: string }>;
  removed?: string[];
  note?: string;
};
type ConflictData = {
  conflicts: Array<{ calendarId: string; eventId?: string | null; title?: string | null; calendar_label?: string; status: string }>;
  clear: boolean;
  partial?: Array<{ mailbox_label: string; error: string }>;
  removed?: string[];
};

function data<T>(r: ToolResult): T {
  expect(r, JSON.stringify(r)).toMatchObject({ success: true });
  return (r as { success: true; data: unknown }).data as T;
}

const free = (router: ToolContext['calendarRouter'], input: Record<string, unknown> = {}) =>
  new CalendarFindFreeTimeHandler().execute(ctx(router, { calendarIds: ['primary'], timeMin: T0, timeMax: T1, duration: 30, ...input }));
const conflicts = (router: ToolContext['calendarRouter'], input: Record<string, unknown> = {}) =>
  new CalendarCheckConflictsHandler().execute(ctx(router, { calendarIds: [WORK_HOME], proposedStart: '2026-11-20T16:00:00Z', proposedEnd: '2026-11-20T17:00:00Z', ...input }));

describe('availability across the principal\'s calendars', () => {
  it('reads every home calendar', async () => {
    const { clients, router } = twoAccounts(
      [evt('w1', 'Board prep', '2026-11-20T15:00:00Z', '2026-11-20T16:00:00Z')],
      [evt('p1', 'Dentist', '2026-11-20T16:30:00Z', '2026-11-20T17:00:00Z')],
    );
    // Only the work calendar is named; the personal one is read anyway (D7).
    const d = data<FreeData>(await free(router, { calendarIds: [WORK_HOME] }));
    expect(clients.work.listEvents).toHaveBeenCalledWith(WORK_HOME, T0, T1, { limit: LIST_EVENTS_MAX_TOTAL, expandRecurring: true });
    expect(clients.personal.listEvents).toHaveBeenCalledWith(PERSONAL_HOME, T0, T1, { limit: LIST_EVENTS_MAX_TOTAL, expandRecurring: true });
    expect(d.blocking.map((b) => [b.eventId, b.title, b.calendar_label])).toEqual([
      ['w1', 'Board prep', 'Work'],
      ['p1', 'Dentist', 'Personal'],
    ]);
    expect(d.freeWindows).toEqual([
      { start: '2026-11-20T16:00:00.000Z', end: '2026-11-20T16:30:00.000Z' },
      { start: '2026-11-20T17:00:00.000Z', end: '2026-11-20T18:00:00.000Z' },
    ]);
    expect(d.partial).toBeUndefined();
  });

  it('partial when one grant fails, never clear', async () => {
    const { clients, router } = twoAccounts([], []);
    clients.personal.listEvents.mockRejectedValue(Object.assign(new Error('Nylas: grant expired'), { statusCode: 401 }));
    const c = data<ConflictData>(await conflicts(router));
    expect(c.conflicts).toEqual([]);
    expect(c.clear).toBe(false);
    expect(c.partial).toEqual([{ mailbox_label: 'Personal', error: 'Nylas: grant expired' }]);

    const d = data<FreeData>(await free(router));
    expect(d.partial).toEqual([{ mailbox_label: 'Personal', error: 'Nylas: grant expired' }]);
    expect(d.note).toContain('Personal');
  });

  it("a mailbox whose home calendar cannot be found is partial, not skipped", async () => {
    const { router } = twoAccounts([], [], {
      principalCalendars: [{ nylasCalendarId: WORK_HOME, isPrimary: true, principalMailboxId: 'work' }],
    });
    const c = data<ConflictData>(await conflicts(router));
    expect(c.clear).toBe(false);
    expect(c.partial?.map((p) => p.mailbox_label)).toEqual(['Personal']);
  });

  it("a removed mailbox's calendar is listed as removed, not partial", async () => {
    const { router } = twoAccounts([], [], {
      removed: { old: 'Old job' },
      principalCalendars: [
        { nylasCalendarId: WORK_HOME, isPrimary: true, principalMailboxId: 'work' },
        { nylasCalendarId: PERSONAL_HOME, isPrimary: true, principalMailboxId: 'personal' },
        { nylasCalendarId: 'ceo@oldjob.example.com', isPrimary: true, principalMailboxId: 'old' },
      ],
      registry: { 'ceo@oldjob.example.com': { principalMailboxId: 'old', contactId: TEST_PRINCIPAL_CONTACT_ID } },
    });
    const c = data<ConflictData>(await conflicts(router, { calendarIds: [WORK_HOME, 'ceo@oldjob.example.com'] }));
    expect(c.removed).toEqual(['Old job']);
    expect(c.partial).toBeUndefined();
    expect(c.clear).toBe(true);
  });

  it("treat_as_free lets the cleaner's visit not block", async () => {
    const cleaner = evt('p-clean', 'Cleaner', '2026-11-20T16:00:00Z', '2026-11-20T17:00:00Z');
    const { router } = twoAccounts([], [cleaner]);
    const first = data<FreeData>(await free(router, { duration: 180 }));
    expect(first.freeWindows).toEqual([]);
    expect(first.blocking.map((b) => [b.eventId, b.title, b.calendar_label])).toEqual([['p-clean', 'Cleaner', 'Personal']]);

    const rerun = data<FreeData>(await free(router, { duration: 180, treat_as_free: ['p-clean'] }));
    expect(rerun.freeWindows).toEqual([{ start: '2026-11-20T15:00:00.000Z', end: '2026-11-20T18:00:00.000Z' }]);
    expect(rerun.blocking).toEqual([]);
    expect(rerun.treated_as_free.map((b) => [b.eventId, b.title, b.calendar_label])).toEqual([['p-clean', 'Cleaner', 'Personal']]);
  });

  it('treat_as_free names an id that matched nothing', async () => {
    const { router } = twoAccounts([], []);
    const d = data<FreeData>(await free(router, { treat_as_free: ['nope'] }));
    expect(d.treat_as_free_unmatched).toEqual(['nope']);
  });

  it('events marked free never block', async () => {
    const { router } = twoAccounts([evt('w-free', 'Focus (free)', '2026-11-20T16:00:00Z', '2026-11-20T17:00:00Z', { busy: false })], []);
    const d = data<FreeData>(await free(router, { duration: 180 }));
    expect(d.blocking).toEqual([]);
    expect(d.freeWindows).toHaveLength(1);
    expect(data<ConflictData>(await conflicts(router)).clear).toBe(true);
  });

  it('cancelled and declined events do not block', async () => {
    const declined = evt('w-dec', 'Optional sync', '2026-11-20T16:00:00Z', '2026-11-20T17:00:00Z', {
      participants: [{ email: 'CEO@work.example.com', name: '', status: 'no' }],
    });
    const cancelled = evt('w-can', 'Old meeting', '2026-11-20T16:00:00Z', '2026-11-20T17:00:00Z', { status: 'cancelled' });
    const { router } = twoAccounts([declined, cancelled], []);
    expect(data<ConflictData>(await conflicts(router)).clear).toBe(true);
  });

  it('conflicts carry titles', async () => {
    const { router } = twoAccounts([], [evt('p1', 'Cleaner', '2026-11-20T16:00:00Z', '2026-11-20T18:00:00Z')]);
    const c = data<ConflictData>(await conflicts(router));
    expect(c.clear).toBe(false);
    expect(c.conflicts).toEqual([
      expect.objectContaining({ eventId: 'p1', title: 'Cleaner', calendar_label: 'Personal', calendarId: PERSONAL_HOME, status: 'busy' }),
    ]);
  });

  it('a busy time the listing does not explain still blocks, untitled', async () => {
    const { clients, router } = twoAccounts([], []);
    // A recurring occurrence the listing missed: free/busy has it, the events do not.
    clients.work.getFreeBusy.mockResolvedValue([{ email: WORK_HOME, timeSlots: [{ startTime: at('2026-11-20T16:00:00Z'), endTime: at('2026-11-20T16:30:00Z'), status: 'busy' }] }]);
    const c = data<ConflictData>(await conflicts(router));
    expect(c.clear).toBe(false);
    expect(c.conflicts).toEqual([expect.objectContaining({ eventId: null, title: null, calendar_label: 'Work' })]);
  });

  it('the same meeting on both calendars blocks once, labelled with both', async () => {
    const shared = { icalUid: 'uid-1@google.com' };
    const { router } = twoAccounts(
      [evt('w1', 'Acme sync', '2026-11-20T16:00:00Z', '2026-11-20T17:00:00Z', shared)],
      [evt('p1', 'Acme sync', '2026-11-20T16:00:00Z', '2026-11-20T17:00:00Z', shared)],
    );
    const d = data<FreeData>(await free(router));
    expect(d.blocking.map((b) => [b.eventId, b.calendar_label])).toEqual([['w1', 'Work, Personal']]);
    // Treating one copy as free treats the other too.
    const rerun = data<FreeData>(await free(router, { treat_as_free: ['w1'] }));
    expect(rerun.blocking).toEqual([]);
  });

  it('a matching Curia hold of this conversation does not conflict', async () => {
    const { router } = twoAccounts([evt('h1', 'HOLD (TBC): Acme sync', '2026-11-20T16:00:00Z', '2026-11-20T17:00:00Z', {
      status: 'tentative',
      metadata: buildHoldMetadata({ createdAtIso: '2026-11-19T00:00:00Z', subject: 'Acme sync', sourceRef: 'msg-1' }),
    })], []);
    expect(data<ConflictData>(await conflicts(router)).clear).toBe(false);
    expect(data<ConflictData>(await conflicts(router, { ignoreHoldCriteria: { sourceRef: 'msg-1' } })).clear).toBe(true);
  });

  it('no calendar readable at all is an error, as before', async () => {
    const { clients, router } = twoAccounts([], []);
    clients.work.listEvents.mockRejectedValue(new Error('work down'));
    clients.personal.listEvents.mockRejectedValue(new Error('personal down'));
    const r = await free(router);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('work down');
  });

  it("another person's calendar on a single-mailbox install is read as free/busy, as before", async () => {
    const c = client();
    const router = singleMailboxRouter(c);
    const d = data<FreeData>(await new CalendarFindFreeTimeHandler().execute(ctx(router, { calendarIds: ['someone@example.org'], timeMin: T0, timeMax: T1 })));
    expect(c.listEvents).not.toHaveBeenCalled();
    expect(c.getFreeBusy).toHaveBeenCalledWith(['someone@example.org'], T0, T1);
    expect(d).not.toHaveProperty('blocking');
  });
});
