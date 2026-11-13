// Every calendar tool goes through the mailbox the calendar belongs to (#2475, Task 31).
// Two live mailboxes, `work` (default) and `personal`, each with its own stub calendar client.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { ToolContext, ToolHandler } from '../../../src/skills/types.js';
import { calendarMailbox, routerFixture, type RouterFixture } from '../../../skills/_shared/calendar-router-test-helpers.js';
import { CalendarCheckConflictsHandler } from '../../../skills/calendar/tools/calendar-check-conflicts/handler.js';
import { CalendarCreateEventHandler } from '../../../skills/calendar/tools/calendar-create-event/handler.js';
import { CalendarCreateHoldHandler } from '../../../skills/calendar/tools/calendar-create-hold/handler.js';
import { CalendarDeleteEventHandler } from '../../../skills/calendar/tools/calendar-delete-event/handler.js';
import { CalendarFindFreeTimeHandler } from '../../../skills/calendar/tools/calendar-find-free-time/handler.js';
import { CalendarHoldsSweepHandler } from '../../../skills/calendar/tools/calendar-holds-sweep/handler.js';
import { CalendarListCalendarsHandler } from '../../../skills/calendar/tools/calendar-list-calendars/handler.js';
import { CalendarListEventsHandler } from '../../../skills/calendar/tools/calendar-list-events/handler.js';
import { CalendarRespondToInviteHandler } from '../../../skills/calendar/tools/calendar-respond-to-invite/handler.js';
import { CalendarUpdateEventHandler } from '../../../skills/calendar/tools/calendar-update-event/handler.js';

const logger = pino({ level: 'silent' });
const PRINCIPAL = '00000000-0000-4000-8000-0000000000aa';
const START = '2026-11-20T15:00:00Z';
const END = '2026-11-20T16:00:00Z';

function event(id: string, calendarId: string) {
  return {
    id, title: id, description: '', location: '', startTime: 1_795_100_000, endTime: 1_795_103_600,
    startDate: null, endDate: null, participants: [], conferencing: null, status: 'confirmed',
    calendarId, busy: true, metadata: null,
  };
}

function stubClient() {
  return {
    listCalendars: vi.fn().mockResolvedValue([]),
    listEvents: vi.fn().mockResolvedValue([]),
    getEvent: vi.fn().mockImplementation(async (cal: string, id: string) => event(id, cal)),
    createEvent: vi.fn().mockImplementation(async (cal: string) => event('new-evt', cal)),
    updateEvent: vi.fn().mockImplementation(async (cal: string, id: string) => event(id, cal)),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    sendRsvp: vi.fn().mockResolvedValue({ requestId: 'r1', sendIcsError: null }),
    getFreeBusy: vi.fn().mockImplementation(async (ids: string[]) => ids.map((email) => ({ email, timeSlots: [] }))),
  };
}


function setup(extra: Partial<RouterFixture> = {}) {
  const work = stubClient();
  const personal = stubClient();
  const router = routerFixture({
    mailboxes: [
      calendarMailbox('work', 'Work', 'ceo@work.example.com', true),
      calendarMailbox('personal', 'Personal', 'ceo@personal.example.com'),
    ],
    clients: { work, personal },
    registry: {
      'cal-work': { principalMailboxId: 'work' },
      'cal-personal': { principalMailboxId: 'personal' },
    },
    ...extra,
  });
  return { work, personal, router };
}

function ctx(router: ToolContext['calendarRouter'], input: Record<string, unknown>, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    toolName: 'calendar-test', toolVersion: '0.0.0', input, log: logger,
    secret: () => { throw new Error('no secrets'); },
    calendarRouter: router,
    contactService: {
      resolveCalendar: vi.fn().mockResolvedValue(null),
      getContact: vi.fn().mockResolvedValue(null),
      getCalendarsForContact: vi.fn().mockResolvedValue([
        { nylasCalendarId: 'cal-work' },
        { nylasCalendarId: 'cal-personal' },
      ]),
    } as never,
    ...extra,
  };
}

async function run(handler: ToolHandler, c: ToolContext) {
  return handler.execute(c);
}

function errorOf(r: Awaited<ReturnType<ToolHandler['execute']>>): string {
  expect(r.success).toBe(false);
  return r.success ? '' : r.error;
}

describe('calendar tools route each calendar through its mailbox', () => {
  it('delete-event deletes through the registered mailbox', async () => {
    const { work, personal, router } = setup();
    const r = await run(new CalendarDeleteEventHandler(), ctx(router, { calendarId: 'cal-personal', eventId: 'e1' }));
    expect(r.success).toBe(true);
    expect(personal.deleteEvent).toHaveBeenCalledWith('cal-personal', 'e1', undefined);
    expect(work.deleteEvent).not.toHaveBeenCalled();
  });

  it('update-event updates through the registered mailbox', async () => {
    const { work, personal, router } = setup();
    const r = await run(new CalendarUpdateEventHandler(), ctx(router, { calendarId: 'cal-personal', eventId: 'e1', title: 'New' }));
    expect(r.success).toBe(true);
    expect(personal.updateEvent).toHaveBeenCalled();
    expect(work.updateEvent).not.toHaveBeenCalled();
  });

  it('create-event creates through the registered mailbox and releases holds there', async () => {
    const { work, personal, router } = setup();
    const r = await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'cal-personal', title: 'T', start: START, end: END }));
    expect(r.success).toBe(true);
    expect(personal.createEvent).toHaveBeenCalledWith('cal-personal', expect.objectContaining({ title: 'T' }));
    expect(personal.listEvents).toHaveBeenCalledWith('cal-personal', START, END);
    expect(work.createEvent).not.toHaveBeenCalled();
  });

  it("create-event with primary and a mailbox writes to that mailbox's home calendar by its real ID", async () => {
    const { personal, router } = setup({
      principalCalendars: [{ nylasCalendarId: 'ceo@personal.example.com', isPrimary: true, principalMailboxId: 'personal' }],
    });
    const r = await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'primary', title: 'T', start: START, end: END, mailbox: 'personal' }));
    expect(r.success).toBe(true);
    expect(personal.createEvent).toHaveBeenCalledWith('ceo@personal.example.com', expect.anything());
  });

  it('create-event refuses bare primary with two mailboxes and creates nothing', async () => {
    const { work, personal, router } = setup();
    const err = errorOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'primary', title: 'T', start: START, end: END })));
    expect(err).toContain('pass mailbox');
    expect(work.createEvent).not.toHaveBeenCalled();
    expect(personal.createEvent).not.toHaveBeenCalled();
  });

  it('create-hold: an unregistered calendar needs a mailbox (a tool error, not a silent held:false)', async () => {
    const { work, router } = setup();
    const err = errorOf(await run(new CalendarCreateHoldHandler(), ctx(router, { calendarId: 'team@group.calendar.google.com', start: START, end: END })));
    expect(err).toContain('work (Work)');
    expect(work.createEvent).not.toHaveBeenCalled();
  });

  it('create-hold places the hold through the named mailbox', async () => {
    const { personal, router } = setup();
    const r = await run(new CalendarCreateHoldHandler(), ctx(router, { calendarId: 'team@group.calendar.google.com', start: START, end: END, mailbox: 'personal' }));
    expect(r.success).toBe(true);
    expect(personal.createEvent).toHaveBeenCalledWith('team@group.calendar.google.com', expect.objectContaining({ status: 'tentative' }));
  });

  it('respond-to-invite answers as the mailbox the calendar belongs to', async () => {
    const { work, personal, router } = setup();
    const r = await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-personal', eventId: 'e1', response: 'accept' }));
    expect(r.success).toBe(true);
    expect(personal.sendRsvp).toHaveBeenCalledWith('cal-personal', 'e1', 'yes');
    expect(work.sendRsvp).not.toHaveBeenCalled();
  });

  it('check-conflicts asks each mailbox for its own calendars', async () => {
    const { work, personal, router } = setup();
    const r = await run(new CalendarCheckConflictsHandler(), ctx(router, { calendarIds: ['cal-work', 'cal-personal'], proposedStart: START, proposedEnd: END }));
    expect(r.success).toBe(true);
    expect(work.getFreeBusy).toHaveBeenCalledWith(['cal-work'], START, END);
    expect(personal.getFreeBusy).toHaveBeenCalledWith(['cal-personal'], START, END);
  });

  it('check-conflicts reports a busy slot from the second mailbox against the calendar asked about', async () => {
    const { personal, router } = setup();
    personal.getFreeBusy.mockResolvedValue([{ email: 'cal-personal', timeSlots: [{ startTime: 1_795_100_000, endTime: 1_795_200_000, status: 'busy' }] }]);
    const r = await run(new CalendarCheckConflictsHandler(), ctx(router, { calendarIds: ['cal-work', 'cal-personal'], proposedStart: '2026-11-20T00:00:00Z', proposedEnd: '2026-11-30T00:00:00Z' }));
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as { conflicts: Array<{ calendarId: string }>; clear: boolean };
      expect(data.clear).toBe(false);
      expect(data.conflicts.map((c) => c.calendarId)).toEqual(['cal-personal']);
    }
  });

  it('find-free-time needs a mailbox for an unregistered calendar when two exist', async () => {
    const { work, router } = setup();
    const err = errorOf(await run(new CalendarFindFreeTimeHandler(), ctx(router, { calendarIds: ['someone@example.org'], timeMin: START, timeMax: END })));
    expect(err).toContain('pass mailbox');
    expect(work.getFreeBusy).not.toHaveBeenCalled();
  });

  it('find-free-time asks each mailbox for its own calendars', async () => {
    const { work, personal, router } = setup();
    const r = await run(new CalendarFindFreeTimeHandler(), ctx(router, { calendarIds: ['cal-work', 'cal-personal', 'someone@example.org'], timeMin: START, timeMax: END, mailbox: 'work' }));
    expect(r.success).toBe(true);
    expect(work.getFreeBusy).toHaveBeenCalledWith(['cal-work', 'someone@example.org'], START, END);
    expect(personal.getFreeBusy).toHaveBeenCalledWith(['cal-personal'], START, END);
  });

  it("list-events reads each of a contact's calendars through its own mailbox", async () => {
    const { work, personal, router } = setup();
    work.listEvents.mockResolvedValue([event('w1', 'cal-work')]);
    personal.listEvents.mockResolvedValue([event('p1', 'cal-personal')]);
    const r = await run(new CalendarListEventsHandler(), ctx(router, { contactId: PRINCIPAL, timeMin: START, timeMax: END }, {
      taskMetadata: { originator: { systemRole: 'system' } },
    }));
    expect(r.success).toBe(true);
    expect(work.listEvents).toHaveBeenCalledWith('cal-work', START, END, undefined);
    expect(personal.listEvents).toHaveBeenCalledWith('cal-personal', START, END, undefined);
    if (r.success) expect((r.data as { count: number }).count).toBe(2);
  });

  it('list-events returns the routing error for an explicit unregistered calendar', async () => {
    const { router } = setup();
    const err = errorOf(await run(new CalendarListEventsHandler(), ctx(router, { calendarId: 'someone@example.org', timeMin: START, timeMax: END })));
    expect(err).toContain('pass mailbox');
  });

  it("list-calendars lists every mailbox's calendars, each labelled with its mailbox", async () => {
    const { work, personal, router } = setup();
    work.listCalendars.mockResolvedValue([{ id: 'cal-work', name: 'W', description: '', timezone: 'UTC', isPrimary: true, readOnly: false, isOwnedByUser: true }]);
    personal.listCalendars.mockResolvedValue([{ id: 'cal-personal', name: 'P', description: '', timezone: 'UTC', isPrimary: true, readOnly: false, isOwnedByUser: true }]);
    const r = await run(new CalendarListCalendarsHandler(), ctx(router, {}));
    expect(r.success).toBe(true);
    if (r.success) {
      const cals = (r.data as { calendars: Array<{ id: string; mailbox: string; mailbox_label: string }> }).calendars;
      expect(cals.map((c) => [c.id, c.mailbox, c.mailbox_label])).toEqual([
        ['cal-work', 'work', 'Work'],
        ['cal-personal', 'personal', 'Personal'],
      ]);
    }
  });

  it('list-calendars with mailbox lists that mailbox only; one failing mailbox is a warning', async () => {
    const { work, personal, router } = setup();
    personal.listCalendars.mockRejectedValue(Object.assign(new Error('grant gr-secret revoked'), { statusCode: 401 }));
    const only = await run(new CalendarListCalendarsHandler(), ctx(router, { mailbox: 'work' }));
    expect(only, JSON.stringify(only)).toMatchObject({ success: true });
    expect(personal.listCalendars).not.toHaveBeenCalled();
    const both = await run(new CalendarListCalendarsHandler(), ctx(router, {}));
    expect(both, JSON.stringify(both)).toMatchObject({ success: true });
    if (both.success) {
      const warnings = (both.data as { warnings: string[] }).warnings;
      expect(warnings[0]).toContain('Personal');
      expect(warnings[0]).not.toContain('gr-secret');
    }
    expect(work.listCalendars).toHaveBeenCalledTimes(2);
  });

  it("holds-sweep sweeps each calendar through its own mailbox and skips a removed mailbox's", async () => {
    const { work, personal, router } = setup({
      removed: { old: 'Old' },
      registry: {
        'cal-work': { principalMailboxId: 'work' },
        'cal-personal': { principalMailboxId: 'personal' },
        'cal-old': { principalMailboxId: 'old' },
      },
    });
    const c = ctx(router, { contactId: PRINCIPAL });
    (c.contactService!.getCalendarsForContact as ReturnType<typeof vi.fn>).mockResolvedValue([
      { nylasCalendarId: 'cal-work' }, { nylasCalendarId: 'cal-personal' }, { nylasCalendarId: 'cal-old' },
    ]);
    const r = await run(new CalendarHoldsSweepHandler(), c);
    expect(r.success).toBe(true);
    expect(work.listEvents).toHaveBeenCalledWith('cal-work', expect.any(String), expect.any(String));
    expect(personal.listEvents).toHaveBeenCalledWith('cal-personal', expect.any(String), expect.any(String));
    if (r.success) expect((r.data as { calendarErrors: number }).calendarErrors).toBe(1);
  });

  it('every tool refuses an unknown mailbox instead of using the default', async () => {
    const { work, router } = setup();
    const err = errorOf(await run(new CalendarDeleteEventHandler(), ctx(router, { calendarId: 'someone@example.org', eventId: 'e1', mailbox: 'nope' })));
    expect(err).toContain('Unknown mailbox "nope"');
    expect(work.deleteEvent).not.toHaveBeenCalled();
  });

  it('a non-string mailbox is an input error', async () => {
    const { router } = setup();
    const err = errorOf(await run(new CalendarDeleteEventHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'e1', mailbox: 7 })));
    expect(err).toContain('mailbox must be a mailbox id');
  });
});
