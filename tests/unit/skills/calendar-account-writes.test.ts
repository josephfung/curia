// Events, holds and RSVPs land on the right account's calendar (#2475, Task 32; D5, D7).
// Two live mailboxes, `work` (default) and `personal`, each with its own stub calendar client.
// `cal-work` / `cal-personal` are the principal's registered calendars; each mailbox's home
// calendar is its own address.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { ToolContext, ToolHandler, ToolResult } from '../../../src/skills/types.js';
import { calendarMailbox, noEvidence, routerFixture, singleMailboxRouter, type RouterFixture } from '../../../skills/_shared/calendar-router-test-helpers.js';
import { CalendarCreateEventHandler } from '../../../skills/calendar/tools/calendar-create-event/handler.js';
import { CalendarCreateHoldHandler } from '../../../skills/calendar/tools/calendar-create-hold/handler.js';
import { CalendarDeleteEventHandler } from '../../../skills/calendar/tools/calendar-delete-event/handler.js';
import { CalendarUpdateEventHandler } from '../../../skills/calendar/tools/calendar-update-event/handler.js';
import { ApprovalMailboxUnboundError, bindApprovalMailbox, calendarWritePregate } from '../../../src/channels/calendar/needs-mailbox.js';
import { CalendarHoldsSweepHandler } from '../../../skills/calendar/tools/calendar-holds-sweep/handler.js';
import { CalendarListEventsHandler } from '../../../skills/calendar/tools/calendar-list-events/handler.js';
import { CalendarRespondToInviteHandler } from '../../../skills/calendar/tools/calendar-respond-to-invite/handler.js';
import { buildHoldMetadata } from '../../../src/channels/calendar/holds.js';
import type { NylasCalendarEvent } from '../../../src/channels/calendar/nylas-calendar-client.js';

const logger = pino({ level: 'silent' });
const PRINCIPAL = '00000000-0000-4000-8000-0000000000aa';
const START = '2026-11-20T15:00:00Z';
const END = '2026-11-20T16:00:00Z';
const START_UNIX = Date.parse(START) / 1000;
const END_UNIX = Date.parse(END) / 1000;
const WORK = calendarMailbox('work', 'Work', 'ceo@work.example.com', true);
const PERSONAL = calendarMailbox('personal', 'Personal', 'ceo@personal.example.com');

function event(id: string, calendarId: string, extra: Partial<NylasCalendarEvent> = {}): NylasCalendarEvent {
  return {
    id, title: id, description: '', location: '', startTime: START_UNIX, endTime: END_UNIX,
    startDate: null, endDate: null, participants: [], conferencing: null, status: 'confirmed',
    calendarId, busy: true, metadata: null, ...extra,
  };
}

function hold(id: string, calendarId: string, extra: Partial<NylasCalendarEvent> = {}): NylasCalendarEvent {
  return event(id, calendarId, {
    status: 'tentative',
    metadata: buildHoldMetadata({ createdAtIso: '2026-11-01T00:00:00Z', threadRef: 'thread-1', subject: 'Q3 audit' }),
    ...extra,
  });
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
    getFreeBusy: vi.fn().mockResolvedValue([]),
  };
}

function setup(extra: Partial<RouterFixture> = {}) {
  const work = stubClient();
  const personal = stubClient();
  const evidence = vi.fn(async (_recipients: string[]) => [
    noEvidence(WORK, { sent_count: 4, domain_match: true }),
    noEvidence(PERSONAL),
  ]);
  const router = routerFixture({
    mailboxes: [WORK, PERSONAL],
    clients: { work, personal },
    registry: {
      'cal-work': { principalMailboxId: 'work', contactId: PRINCIPAL },
      'cal-personal': { principalMailboxId: 'personal', contactId: PRINCIPAL },
      'curia-own': { principalMailboxId: 'work', contactId: '00000000-0000-4000-8000-0000000000bb' },
    },
    principalCalendars: [
      { nylasCalendarId: 'ceo@work.example.com', isPrimary: true, principalMailboxId: 'work' },
      { nylasCalendarId: 'ceo@personal.example.com', isPrimary: true, principalMailboxId: 'personal' },
    ],
    evidence,
    ...extra,
  });
  return { work, personal, router, evidence };
}

function ctx(router: ToolContext['calendarRouter'], input: Record<string, unknown>, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    toolName: 'calendar-test', toolVersion: '0.0.0', input, log: logger,
    secret: () => { throw new Error('no secrets'); },
    calendarRouter: router,
    contactService: {
      resolveCalendar: vi.fn().mockResolvedValue(null),
      getContact: vi.fn().mockResolvedValue(null),
      getCalendarsForContact: vi.fn().mockResolvedValue([{ nylasCalendarId: 'cal-work' }, { nylasCalendarId: 'cal-personal' }]),
    } as never,
    ...extra,
  };
}

function dataOf(r: ToolResult): Record<string, unknown> {
  expect(r, JSON.stringify(r)).toMatchObject({ success: true });
  return r.success ? (r.data as Record<string, unknown>) : {};
}

function errorOf(r: ToolResult): string {
  expect(r.success).toBe(false);
  return r.success ? '' : r.error;
}

function noWrites(...clients: Array<ReturnType<typeof stubClient>>) {
  for (const c of clients) {
    expect(c.createEvent).not.toHaveBeenCalled();
    expect(c.deleteEvent).not.toHaveBeenCalled();
    expect(c.sendRsvp).not.toHaveBeenCalled();
  }
}

const run = (h: ToolHandler, c: ToolContext) => h.execute(c);

describe('calendar-create-event: the account is a stated choice (D5)', () => {
  it('create-event without mailbox fails with needs_mailbox and creates nothing (R102)', async () => {
    const { work, personal, router, evidence } = setup();
    const r = await run(new CalendarCreateEventHandler(), ctx(router, {
      calendarId: 'cal-work', title: 'Q3 audit', start: START, end: END,
      attendees: [{ email: 'CFO@Work.example.com' }, { email: 'ceo@personal.example.com' }],
    }));
    // A failure, so the runtime never records it as a sent invite nor the feed as a booking.
    const err = errorOf(r);
    expect(err).toContain('needs_mailbox: nothing was created');
    expect(err).toContain('one of: work (Work), personal (Personal)');
    expect(err).toContain('Evidence for the attendees: Work: sent 4, received 0, same domain; Personal: sent 0, received 0');
    // Attendees are normalized and the principal's own addresses are left out.
    expect(evidence).toHaveBeenCalledWith(['cfo@work.example.com']);
    noWrites(work, personal);
  });

  it('bare primary with two mailboxes is needs_mailbox too, and creates nothing', async () => {
    const { work, personal, router, evidence } = setup();
    const err = errorOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'primary', title: 'Focus', start: START, end: END })));
    expect(err).toContain('needs_mailbox: nothing was created');
    // No attendees: no evidence is computed.
    expect(err).not.toContain('Evidence');
    expect(evidence).not.toHaveBeenCalled();
    noWrites(work, personal);
  });

  it('refuses a calendar from another mailbox', async () => {
    const { work, personal, router } = setup();
    const err = errorOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'cal-work', title: 'T', start: START, end: END, mailbox: 'personal' })));
    expect(err).toContain('calendar_mailbox_mismatch');
    expect(err).toContain('"work" (Work)');
    noWrites(work, personal);
  });

  it('update and delete refuse a stated mailbox that does not own the calendar, rather than quietly overriding it (SF-M1)', async () => {
    const { work, personal, router } = setup();
    const del = errorOf(await run(new CalendarDeleteEventHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'e1', mailbox: 'personal' })));
    expect(del).toContain('calendar_mailbox_mismatch');
    const upd = errorOf(await run(new CalendarUpdateEventHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'e1', title: 'New', mailbox: 'personal' })));
    expect(upd).toContain('calendar_mailbox_mismatch');
    noWrites(work, personal);
    expect(work.updateEvent).not.toHaveBeenCalled();
    // Without a mailbox, a registered calendar still goes through its own.
    await run(new CalendarDeleteEventHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'e1' }));
    expect(work.deleteEvent).toHaveBeenCalledWith('cal-work', 'e1', undefined);
  });

  it("an unregistered calendar another account owns is refused through the account it is only shared into (SEC-L1)", async () => {
    const { work, personal, router } = setup();
    const shared = 'c_family@group.calendar.google.com';
    personal.listCalendars.mockResolvedValue([{ id: shared, name: 'Family', isPrimary: false, readOnly: false, isOwnedByUser: true }]);
    const err = errorOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: shared, title: 'T', start: START, end: END, mailbox: 'work' })));
    expect(err).toContain('is owned by mailbox "personal" (Personal)');
    noWrites(work, personal);
    // Through the owner it goes ahead.
    dataOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: shared, title: 'T', start: START, end: END, mailbox: 'personal' })));
    expect(personal.createEvent).toHaveBeenCalledWith(shared, expect.anything());
  });

  it("a principal calendar placed only by the hint is refused through it when another account owns it (R105)", async () => {
    // Registered to the principal but with no mailbox (registered during the deferred fallback):
    // the `mailbox` hint places it, so ownership is checked even though it is the principal's.
    const unplaced = 'c_board@group.calendar.google.com';
    const { work, personal, router } = setup({
      registry: {
        'cal-work': { principalMailboxId: 'work', contactId: PRINCIPAL },
        [unplaced]: { principalMailboxId: null, contactId: PRINCIPAL },
      },
    });
    personal.listCalendars.mockResolvedValue([{ id: unplaced, name: 'Board', isPrimary: false, readOnly: false, isOwnedByUser: true }]);
    const err = errorOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: unplaced, title: 'T', start: START, end: END, mailbox: 'work' })));
    expect(err).toContain('is owned by mailbox "personal" (Personal)');
    noWrites(work, personal);
    // A registered calendar is placed by its row: no ownership listing.
    personal.listCalendars.mockClear();
    dataOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'cal-work', title: 'T', start: START, end: END, mailbox: 'work' })));
    expect(personal.listCalendars).not.toHaveBeenCalled();
  });

  it("fails closed when another account's calendars cannot be listed to confirm the owner (R106)", async () => {
    const { work, personal, router } = setup();
    personal.listCalendars.mockRejectedValue(new Error('nylas 503'));
    const err = errorOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'c_x@group.calendar.google.com', title: 'T', start: START, end: END, mailbox: 'work' })));
    expect(err).toContain('Could not confirm which account owns calendar');
    expect(err).toContain('personal (Personal)');
    expect(err).toContain('Nothing was changed; try again shortly');
    noWrites(work, personal);
  });

  it('the execution-layer pre-gate answers needs_mailbox before any approval, with the same text (BR-m5)', async () => {
    const { router, evidence } = setup();
    const input = { calendarId: 'cal-work', title: 'Q3 audit', start: START, end: END, attendees: [{ email: 'cfo@work.example.com' }] };
    const pre = await calendarWritePregate(router, logger, 'calendar-create-event', input);
    const handler = await run(new CalendarCreateEventHandler(), ctx(router, input));
    expect(pre).toEqual(handler);
    expect(pre).toMatchObject({ success: false, error: expect.stringContaining('needs_mailbox: nothing was created') });
    expect(evidence).toHaveBeenCalledWith(['cfo@work.example.com']);
    // Holds too; nothing for a stated mailbox, a non-principal calendar or another tool.
    expect(await calendarWritePregate(router, logger, 'calendar-create-hold', { calendarId: 'primary' })).toMatchObject({ error: expect.stringContaining('nothing was placed') });
    expect(await calendarWritePregate(router, logger, 'calendar-create-event', { ...input, mailbox: 'work' })).toBeNull();
    // null and '' are absent (N2): answered here, not after an approval.
    for (const mailbox of [null, '']) {
      expect(await calendarWritePregate(router, logger, 'calendar-create-event', { ...input, mailbox }), String(mailbox)).toMatchObject({ success: false, error: expect.stringContaining('needs_mailbox') });
    }
    expect(await calendarWritePregate(router, logger, 'calendar-create-event', { ...input, calendarId: 'curia-own' })).toBeNull();
    expect(await calendarWritePregate(router, logger, 'calendar-update-event', input)).toBeNull();
    // A failed check is not a refusal: the handler checks again.
    Object.assign(router, { liveMailboxes: async () => { throw new Error('registry down'); } });
    expect(await calendarWritePregate(router, logger, 'calendar-create-event', input)).toBeNull();
  });

  it('an approval of a sole-mailbox calendar write stores that mailbox, so a later account cannot replay it', async () => {
    const single = routerFixture({ clients: { work: {} } });
    const input = { calendarId: 'primary', title: 'Q3 audit', start: START, end: END };
    expect(await bindApprovalMailbox(single, logger, 'calendar-create-event', input)).toEqual({ ...input, mailbox: 'work' });
    // A stated mailbox, another tool, or several mailboxes: stored as given.
    expect(await bindApprovalMailbox(single, logger, 'calendar-create-event', { ...input, mailbox: 'work' })).toEqual({ ...input, mailbox: 'work' });
    expect(await bindApprovalMailbox(single, logger, 'email-send', input)).toBe(input);
    const { router } = setup();
    expect(await bindApprovalMailbox(router, logger, 'calendar-create-event', input)).toBe(input);
    // A lookup failure fails closed: no approval is stored that could replay through another account.
    await expect(bindApprovalMailbox({ liveMailboxes: async () => { throw new Error('down'); }, isPrincipalCalendar: async () => true } as never, logger, 'calendar-create-event', input))
      .rejects.toBeInstanceOf(ApprovalMailboxUnboundError);
  });

  it("an account's own calendar (its address) cannot be written through the other account", async () => {
    const { work, personal, router } = setup();
    const err = errorOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'ceo@personal.example.com', title: 'T', start: START, end: END, mailbox: 'work' })));
    expect(err).toContain('calendar_mailbox_mismatch');
    noWrites(work, personal);
  });

  it('with mailbox it creates there and reports the account and the evidence verdict', async () => {
    const { work, personal, router } = setup();
    const data = dataOf(await run(new CalendarCreateEventHandler(), ctx(router, {
      calendarId: 'primary', title: 'Q3 audit', start: START, end: END, mailbox: 'work', attendees: [{ email: 'cfo@work.example.com' }],
    })));
    expect(work.createEvent).toHaveBeenCalledWith('ceo@work.example.com', expect.objectContaining({ title: 'Q3 audit' }));
    expect(personal.createEvent).not.toHaveBeenCalled();
    expect(data).toMatchObject({ mailbox: 'work', mailbox_label: 'Work', evidence: 'agrees' });
  });

  it('evidence leaning to the other account is reported as leans_other', async () => {
    const { router } = setup();
    const data = dataOf(await run(new CalendarCreateEventHandler(), ctx(router, {
      calendarId: 'primary', title: 'Q3 audit', start: START, end: END, mailbox: 'personal', attendees: [{ email: 'cfo@work.example.com' }],
    })));
    expect(data['evidence']).toBe('leans_other');
  });

  it('evidence failing after the create is evidence_unavailable, never a failed booking', async () => {
    const { work, router } = setup({ evidence: async () => { throw new Error('mail down'); } });
    const data = dataOf(await run(new CalendarCreateEventHandler(), ctx(router, {
      calendarId: 'primary', title: 'T', start: START, end: END, mailbox: 'work', attendees: [{ email: 'x@y.example.org' }],
    })));
    expect(work.createEvent).toHaveBeenCalled();
    expect(data['evidence_unavailable']).toBe(true);
  });

  it("a calendar that is not the principal's (Curia's own) needs no mailbox", async () => {
    const { work, router } = setup();
    const data = dataOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'curia-own', title: 'T', start: START, end: END })));
    expect(work.createEvent).toHaveBeenCalledWith('curia-own', expect.anything());
    expect(data).not.toHaveProperty('needs_mailbox');
  });

  it('booking releases a hold on the other calendar', async () => {
    const { work, personal, router } = setup();
    personal.listEvents.mockResolvedValue([hold('hold-p', 'ceo@personal.example.com')]);
    const data = dataOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'cal-work', title: 'Q3 audit', start: START, end: END, mailbox: 'work' })));
    expect(work.createEvent).toHaveBeenCalledWith('cal-work', expect.anything());
    // The booked calendar and both home calendars are searched.
    expect(work.listEvents).toHaveBeenCalledWith('cal-work', START, END);
    expect(work.listEvents).toHaveBeenCalledWith('ceo@work.example.com', START, END);
    expect(personal.listEvents).toHaveBeenCalledWith('ceo@personal.example.com', START, END);
    expect(personal.deleteEvent).toHaveBeenCalledWith('ceo@personal.example.com', 'hold-p');
    expect(data).not.toHaveProperty('warnings');
  });

  it('one home calendar failing to list does not stop the release on the others', async () => {
    const { work, personal, router } = setup();
    work.listEvents.mockRejectedValue(new Error('boom'));
    personal.listEvents.mockResolvedValue([hold('hold-p', 'ceo@personal.example.com')]);
    personal.deleteEvent.mockRejectedValueOnce(new Error('delete failed'));
    const data = dataOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'cal-work', title: 'T', start: START, end: END, mailbox: 'work' })));
    expect(personal.deleteEvent).toHaveBeenCalledWith('ceo@personal.example.com', 'hold-p');
    // Neither the failed listing nor the failed delete is silent (SF-M4).
    const warnings = (data['warnings'] as string[]).join(' ');
    expect(warnings).toContain('Holds on the "Work" mailbox\'s calendar were not checked');
    expect(warnings).toContain('Hold hold-p overlaps this booking but could not be removed');
  });
});

describe('single-mailbox installs are unchanged', () => {
  it('create-event without mailbox creates as before, searches only that calendar, and adds no account fields', async () => {
    const client = stubClient();
    const evidence = vi.fn();
    const router = singleMailboxRouter(client);
    Object.assign(router, { evidence });
    const data = dataOf(await run(new CalendarCreateEventHandler(), ctx(router, {
      calendarId: 'cal-x', title: 'T', start: START, end: END, attendees: [{ email: 'a@b.example.org' }],
    })));
    expect(client.createEvent).toHaveBeenCalledTimes(1);
    expect(client.listEvents).toHaveBeenCalledTimes(1);
    expect(evidence).not.toHaveBeenCalled();
    expect(Object.keys(data).sort()).toEqual(['displayTimezone', 'event']);
  });

  it('create-hold without mailbox places the hold on the calendar given', async () => {
    const client = stubClient();
    const data = dataOf(await run(new CalendarCreateHoldHandler(), ctx(singleMailboxRouter(client), { calendarId: 'cal-x', start: START, end: END })));
    expect(client.createEvent).toHaveBeenCalledWith('cal-x', expect.objectContaining({ status: 'tentative' }));
    expect(data).not.toHaveProperty('mailbox');
  });
});

describe('calendar-create-hold on the right account', () => {
  it('without mailbox on the principal\'s calendar: a needs_mailbox failure, no hold (R102)', async () => {
    const { work, personal, router, evidence } = setup();
    const err = errorOf(await run(new CalendarCreateHoldHandler(), ctx(router, { calendarId: 'primary', start: START, end: END, contactDomain: 'cfo@work.example.com' })));
    expect(err).toContain('needs_mailbox: nothing was placed');
    expect(evidence).toHaveBeenCalledWith(['cfo@work.example.com']);
    noWrites(work, personal);
  });

  it("hold placed on the chosen mailbox's calendar", async () => {
    const { work, personal, router } = setup();
    // A registered principal calendar of `personal`: the hold goes on personal's home calendar.
    const data = dataOf(await run(new CalendarCreateHoldHandler(), ctx(router, { calendarId: 'cal-personal', start: START, end: END, mailbox: 'personal' })));
    expect(personal.createEvent).toHaveBeenCalledWith('ceo@personal.example.com', expect.objectContaining({ status: 'tentative' }));
    expect(work.createEvent).not.toHaveBeenCalled();
    expect(data).toMatchObject({ held: true, mailbox: 'personal', calendarId: 'ceo@personal.example.com' });
  });

  it("refuses a calendar of the other account and places nothing", async () => {
    const { work, personal, router } = setup();
    const err = errorOf(await run(new CalendarCreateHoldHandler(), ctx(router, { calendarId: 'cal-work', start: START, end: END, mailbox: 'personal' })));
    expect(err).toContain('calendar_mailbox_mismatch');
    noWrites(work, personal);
  });
});

describe('calendar-respond-to-invite answers as the arrival mailbox (D7)', () => {
  it('RSVP answers through the arrival mailbox', async () => {
    const { work, personal, router } = setup();
    const data = dataOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'primary', eventId: 'e1', response: 'accept', mailbox: 'personal' })));
    expect(personal.sendRsvp).toHaveBeenCalledWith('ceo@personal.example.com', 'e1', 'yes');
    expect(work.sendRsvp).not.toHaveBeenCalled();
    expect(data['mailbox']).toBe('personal');
  });

  // The invite as each account's calendar shows it: same UID, time, title and organizer.
  const BOARD = { icalUid: 'uid-board', title: 'Board meeting', organizerEmail: 'Chair@Board.example.org' };

  it('RSVP finds the invite in the arrival mailbox by iCal UID', async () => {
    const { work, personal, router } = setup();
    // The agent passes work's copy (calendarId/eventId) but the invite arrived in personal.
    work.getEvent.mockResolvedValue(event('w-77', 'cal-work', BOARD));
    personal.listEvents.mockResolvedValue([
      event('p-other', 'ceo@personal.example.com', { icalUid: 'uid-other' }),
      event('p-77', 'ceo@personal.example.com', { ...BOARD, organizerEmail: 'chair@board.example.org' }),
    ]);
    const data = dataOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept', mailbox: 'personal' })));
    expect(personal.sendRsvp).toHaveBeenCalledWith('ceo@personal.example.com', 'p-77', 'yes');
    expect(work.sendRsvp).not.toHaveBeenCalled();
    // The arrival calendar is searched a day around the invite.
    expect(personal.listEvents).toHaveBeenCalledWith('ceo@personal.example.com', '2026-11-19T15:00:00.000Z', '2026-11-21T16:00:00.000Z');
    expect(data).toMatchObject({ mailbox: 'personal', found_by_ical_uid: true, eventId: 'p-77', calendarId: 'ceo@personal.example.com' });
  });

  it('not found in the arrival mailbox: refused, nothing sent from either account', async () => {
    const { work, personal, router } = setup();
    work.getEvent.mockResolvedValue(event('w-77', 'cal-work', BOARD));
    // Same UID, another occurrence of a series: not this invite.
    personal.listEvents.mockResolvedValue([event('p-next', 'ceo@personal.example.com', { ...BOARD, originalStartTime: START_UNIX + 7 * 86_400 })]);
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept', mailbox: 'personal' })));
    expect(err).toContain('not found');
    expect(err).toContain('"personal" (Personal)');
    noWrites(work, personal);
  });

  it.each([
    ['another title', { title: 'Lunch' }],
    ['another time', { endTime: END_UNIX + 1800 }],
    ['another organizer', { organizerEmail: 'attacker@evil.example.net' }],
    ['no organizer', { organizerEmail: undefined }],
  ])('a spoofed copy with the same UID and occurrence but %s is not answered (R87)', async (_name, diff) => {
    const { work, personal, router } = setup();
    work.getEvent.mockResolvedValue(event('w-77', 'cal-work', BOARD));
    personal.listEvents.mockResolvedValue([event('p-spoof', 'ceo@personal.example.com', { ...BOARD, ...diff })]);
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept', mailbox: 'personal' })));
    expect(err).toContain('not found');
    noWrites(work, personal);
  });

  it('a source invite without an organizer matches nothing', async () => {
    const { work, personal, router } = setup();
    work.getEvent.mockResolvedValue(event('w-77', 'cal-work', { ...BOARD, organizerEmail: undefined }));
    personal.listEvents.mockResolvedValue([event('p-77', 'ceo@personal.example.com', BOARD)]);
    errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept', mailbox: 'personal' })));
    noWrites(work, personal);
  });

  it('two identical matches in the arrival mailbox: refused as ambiguous, nothing sent', async () => {
    const { work, personal, router } = setup();
    work.getEvent.mockResolvedValue(event('w-77', 'cal-work', BOARD));
    personal.listEvents.mockResolvedValue([event('p-a', 'ceo@personal.example.com', BOARD), event('p-b', 'ceo@personal.example.com', BOARD)]);
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept', mailbox: 'personal' })));
    expect(err).toContain('ambiguous');
    noWrites(work, personal);
  });

  it('the source invite cannot be read: refused with the upstream reason, nothing sent (R86)', async () => {
    const { work, personal, router } = setup();
    work.getEvent.mockRejectedValue(new Error('event gone (404)'));
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept', mailbox: 'personal' })));
    expect(err).toContain('Could not read the invite');
    expect(err).toContain('event gone (404)');
    expect(err).toContain('Nothing was sent');
    expect(personal.listEvents).not.toHaveBeenCalled();
    noWrites(work, personal);
  });

  it("the arrival calendar cannot be listed: refused with the upstream reason, nothing sent", async () => {
    const { work, personal, router } = setup();
    work.getEvent.mockResolvedValue(event('w-77', 'cal-work', BOARD));
    personal.listEvents.mockRejectedValue(new Error('rate limited (429)'));
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept', mailbox: 'personal' })));
    expect(err).toContain('Could not search mailbox "personal" (Personal)');
    expect(err).toContain('rate limited (429)');
    noWrites(work, personal);
  });

  it('an invite with no iCal UID cannot be looked up in the other account: refused', async () => {
    const { work, personal, router } = setup();
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept', mailbox: 'personal' })));
    expect(err).toContain('no iCal UID');
    noWrites(work, personal);
  });

  it("principal calendar without mailbox with two live: a needs_mailbox failure with the participants' evidence, nothing sent (R88)", async () => {
    const { work, personal, router, evidence } = setup();
    work.getEvent.mockResolvedValue(event('w-77', 'cal-work', {
      participants: [{ email: 'Chair@Board.example.org', name: 'Chair', status: 'yes' }, { email: 'ceo@work.example.com', name: 'Me', status: 'noreply' }],
    }));
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'w-77', response: 'accept' })));
    expect(err).toContain('needs_mailbox: nothing was sent');
    expect(err).toContain('work (Work), personal (Personal)');
    expect(err).toContain('Work: sent 4, received 0, same domain; Personal: sent 0, received 0');
    expect(evidence).toHaveBeenCalledWith(['chair@board.example.org']);
    noWrites(work, personal);
  });

  it('bare primary without mailbox with two live: a needs_mailbox failure noting the participants could not be read', async () => {
    const { work, personal, router, evidence } = setup();
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'primary', eventId: 'e1', response: 'accept' })));
    expect(err).toContain('needs_mailbox: nothing was sent');
    expect(err).toContain('participants could not be read');
    expect(evidence).not.toHaveBeenCalled();
    noWrites(work, personal);
  });

  it('the old account input is refused, naming mailbox', async () => {
    const { work, personal, router } = setup();
    const err = errorOf(await run(new CalendarRespondToInviteHandler(), ctx(router, { calendarId: 'cal-work', eventId: 'e1', response: 'accept', account: 'work' })));
    expect(err).toContain('mailbox');
    noWrites(work, personal);
  });

  it("accepting releases the conversation's holds on every home calendar", async () => {
    const { work, personal, router } = setup();
    work.listEvents.mockResolvedValue([hold('hold-w', 'ceo@work.example.com')]);
    const data = dataOf(await run(new CalendarRespondToInviteHandler(), ctx(router, {
      calendarId: 'primary', eventId: 'e1', response: 'accept', mailbox: 'personal',
      holdMatchCriteria: { threadRef: 'thread-1' }, holdSearchStart: '2026-11-19T00:00:00Z', holdSearchEnd: '2026-11-22T00:00:00Z',
    })));
    expect(personal.listEvents).toHaveBeenCalledWith('ceo@personal.example.com', '2026-11-19T00:00:00Z', '2026-11-22T00:00:00Z');
    expect(work.deleteEvent).toHaveBeenCalledWith('ceo@work.example.com', 'hold-w');
    expect(data['releasedHolds']).toEqual(['hold-w']);
  });

  it('one conversation ref for every calendar: an overlapping hold of another conversation is left alone', async () => {
    const { work, personal, router } = setup();
    const meta = (thread: string) => buildHoldMetadata({ createdAtIso: '2026-11-01T00:00:00Z', threadRef: thread, subject: 'Q3 audit' });
    // Both calendars hold the accepted slot, for different conversations; personal also has an
    // earlier hold of the first conversation. No ref in the criteria: recovery anchors on overlap.
    work.listEvents.mockResolvedValue([hold('hold-w', 'ceo@work.example.com', { metadata: meta('thread-1') })]);
    personal.listEvents.mockResolvedValue([
      hold('hold-p', 'ceo@personal.example.com', { metadata: meta('thread-2') }),
      hold('hold-p1', 'ceo@personal.example.com', { metadata: meta('thread-1'), startTime: START_UNIX - 86_400, endTime: END_UNIX - 86_400 }),
    ]);
    const data = dataOf(await run(new CalendarRespondToInviteHandler(), ctx(router, {
      calendarId: 'primary', eventId: 'e1', response: 'accept', mailbox: 'personal',
      holdMatchCriteria: { subject: 'Q3 audit', contactDomain: 'example.org' }, holdSearchStart: '2026-11-19T00:00:00Z', holdSearchEnd: '2026-11-22T00:00:00Z',
    })));
    const released = data['releasedHolds'] as string[];
    // Released holds all belong to one conversation: never thread-2's hold-p beside thread-1's.
    const threadOf: Record<string, string> = { 'hold-w': 'thread-1', 'hold-p': 'thread-2', 'hold-p1': 'thread-1' };
    expect(released.length).toBeGreaterThan(0);
    expect(new Set(released.map((id) => threadOf[id])).size).toBe(1);
  });
});

describe('calendar-holds-sweep covers every account', () => {
  it('sweep covers both mailboxes', async () => {
    const { work, personal, router } = setup();
    const c = ctx(router, { contactId: PRINCIPAL, nowMs: Date.parse('2026-11-25T00:00:00Z') });
    // Nothing registered: the sweep still reaches each mailbox's home calendar.
    (c.contactService!.getCalendarsForContact as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    work.listEvents.mockResolvedValue([hold('old-w', 'ceo@work.example.com')]);
    personal.listEvents.mockResolvedValue([hold('old-p', 'ceo@personal.example.com')]);
    const data = dataOf(await run(new CalendarHoldsSweepHandler(), c));
    expect(work.deleteEvent).toHaveBeenCalledWith('ceo@work.example.com', 'old-w');
    expect(personal.deleteEvent).toHaveBeenCalledWith('ceo@personal.example.com', 'old-p');
    expect(data).toMatchObject({ scanned: 2, expired: 2, calendarErrors: 0 });
  });

  it('an upper-case spelling of the principal\'s id still sweeps the home calendars', async () => {
    const { work, personal, router } = setup();
    const c = ctx(router, { contactId: PRINCIPAL.toUpperCase(), nowMs: Date.parse('2026-11-25T00:00:00Z') });
    (c.contactService!.getCalendarsForContact as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    work.listEvents.mockResolvedValue([hold('old-w', 'ceo@work.example.com')]);
    personal.listEvents.mockResolvedValue([hold('old-p', 'ceo@personal.example.com')]);
    expect(dataOf(await run(new CalendarHoldsSweepHandler(), c))).toMatchObject({ scanned: 2, expired: 2 });
  });

  it('a home calendar that is also registered is swept once', async () => {
    const { work, router } = setup();
    const c = ctx(router, { contactId: PRINCIPAL });
    (c.contactService!.getCalendarsForContact as ReturnType<typeof vi.fn>).mockResolvedValue([{ nylasCalendarId: 'ceo@work.example.com' }]);
    dataOf(await run(new CalendarHoldsSweepHandler(), c));
    expect(work.listEvents.mock.calls.filter((call) => call[0] === 'ceo@work.example.com')).toHaveLength(1);
  });

  it('a stated mailbox sweeps only that account', async () => {
    const { work, personal, router } = setup();
    dataOf(await run(new CalendarHoldsSweepHandler(), ctx(router, { contactId: PRINCIPAL, mailbox: 'personal' })));
    expect(work.listEvents).not.toHaveBeenCalled();
    expect(personal.listEvents).toHaveBeenCalled();
  });
});

describe('calendar-list-events lists a meeting on two accounts once (D7)', () => {
  const listInput = { contactId: PRINCIPAL, timeMin: START, timeMax: END };
  const system = { taskMetadata: { originator: { systemRole: 'system' } } } as Partial<ToolContext>;

  it('same meeting on both calendars lists once', async () => {
    const { work, personal, router } = setup();
    work.listEvents.mockResolvedValue([event('w-1', 'cal-work', { icalUid: 'uid-1', title: 'Board' })]);
    personal.listEvents.mockResolvedValue([event('p-1', 'cal-personal', { icalUid: 'uid-1', title: 'Board' }), event('p-2', 'cal-personal', { icalUid: 'uid-2' })]);
    const data = dataOf(await run(new CalendarListEventsHandler(), ctx(router, listInput, system)));
    const events = data['events'] as Array<{ id: string; calendars?: unknown }>;
    expect(data['count']).toBe(2);
    expect(events.map((e) => e.id)).toEqual(['w-1', 'p-2']);
    expect(events[0]!.calendars).toEqual([
      { calendarId: 'cal-work', mailbox: 'work', mailbox_label: 'Work', eventId: 'w-1' },
      { calendarId: 'cal-personal', mailbox: 'personal', mailbox_label: 'Personal', eventId: 'p-1' },
    ]);
    expect(events[1]).not.toHaveProperty('calendars');
  });

  it('events without an iCal UID are never merged', async () => {
    const { work, personal, router } = setup();
    work.listEvents.mockResolvedValue([event('w-1', 'cal-work')]);
    personal.listEvents.mockResolvedValue([event('p-1', 'cal-personal', { icalUid: '' })]);
    const data = dataOf(await run(new CalendarListEventsHandler(), ctx(router, listInput, system)));
    expect(data['count']).toBe(2);
  });

  it('occurrences of one recurring series (one UID) stay separate', async () => {
    const { work, personal, router } = setup();
    const week = 7 * 86_400;
    work.listEvents.mockResolvedValue([
      event('w-a', 'cal-work', { icalUid: 'series', title: 'Weekly', startTime: START_UNIX, originalStartTime: START_UNIX }),
      event('w-b', 'cal-work', { icalUid: 'series', title: 'Weekly', startTime: START_UNIX + week, endTime: END_UNIX + week, originalStartTime: START_UNIX + week }),
    ]);
    personal.listEvents.mockResolvedValue([event('p-a', 'cal-personal', { icalUid: 'series', title: 'Weekly', startTime: START_UNIX, originalStartTime: START_UNIX })]);
    const data = dataOf(await run(new CalendarListEventsHandler(), ctx(router, listInput, system)));
    const events = data['events'] as Array<{ id: string; calendars?: Array<{ eventId: string }> }>;
    expect(events.map((e) => e.id)).toEqual(['w-a', 'w-b']);
    expect(events[0]!.calendars?.map((c) => c.eventId)).toEqual(['w-a', 'p-a']);
    expect(events[1]).not.toHaveProperty('calendars');
  });

  it('a single-mailbox listing is never collapsed', async () => {
    const client = stubClient();
    client.listEvents.mockImplementation(async (cal: string) => [event(`${cal}-1`, cal, { icalUid: 'uid-1' })]);
    const data = dataOf(await run(new CalendarListEventsHandler(), ctx(singleMailboxRouter(client), listInput, system)));
    expect(data['count']).toBe(2);
  });
});

describe('fix round 1: single-mailbox no-ops', () => {
  it('respond-to-invite with one mailbox answers as before and adds no account fields', async () => {
    const client = stubClient();
    const data = dataOf(await run(new CalendarRespondToInviteHandler(), ctx(singleMailboxRouter(client), { calendarId: 'cal-x', eventId: 'e1', response: 'decline' })));
    expect(client.sendRsvp).toHaveBeenCalledWith('cal-x', 'e1', 'no');
    expect(Object.keys(data).sort()).toEqual(
      ['displayTimezone', 'event', 'participantStatus', 'releaseWarnings', 'releasedHolds', 'responded', 'response', 'rsvp', 'warnings'],
    );
  });

  it('a one-mailbox sweep is unchanged even when the mailbox list read fails', async () => {
    const client = stubClient();
    const router = singleMailboxRouter(client);
    Object.assign(router, { liveMailboxes: async () => { throw new Error('registry down'); } });
    const c = ctx(router, { contactId: PRINCIPAL, nowMs: Date.parse('2026-11-25T00:00:00Z') });
    client.listEvents.mockResolvedValue([hold('old', 'cal-work')]);
    const data = dataOf(await run(new CalendarHoldsSweepHandler(), c));
    expect(data).toEqual({ scanned: 2, expired: 2, failed: 0, calendarErrors: 0, skippedWithAttendees: 0 });
  });
});

describe('fix round 1: one broken mailbox costs only its own home calendar (R84)', () => {
  // personal's grant lists no primary calendar and none is registered: its home lookup fails.
  const broken = { principalCalendars: [{ nylasCalendarId: 'ceo@work.example.com', isPrimary: true, principalMailboxId: 'work' }] };

  it("booking still releases a hold on the healthy mailbox's home calendar, and warns about the other", async () => {
    const { work, personal, router } = setup(broken);
    work.listEvents.mockImplementation(async (cal: string) => (cal === 'ceo@work.example.com' ? [hold('hold-w', cal)] : []));
    const data = dataOf(await run(new CalendarCreateEventHandler(), ctx(router, { calendarId: 'cal-work', title: 'T', start: START, end: END, mailbox: 'work' })));
    expect(work.deleteEvent).toHaveBeenCalledWith('ceo@work.example.com', 'hold-w');
    expect(personal.deleteEvent).not.toHaveBeenCalled();
    expect((data['warnings'] as string[]).join(' ')).toContain('"Personal" mailbox\'s home calendar were not checked');
  });

  it("the sweep reaches the healthy mailbox's home calendar and counts one error for the broken one", async () => {
    const { work, router } = setup(broken);
    const c = ctx(router, { contactId: PRINCIPAL, nowMs: Date.parse('2026-11-25T00:00:00Z') });
    (c.contactService!.getCalendarsForContact as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    work.listEvents.mockResolvedValue([hold('old-w', 'ceo@work.example.com')]);
    const data = dataOf(await run(new CalendarHoldsSweepHandler(), c));
    expect(work.deleteEvent).toHaveBeenCalledWith('ceo@work.example.com', 'old-w');
    expect(data).toMatchObject({ expired: 1, calendarErrors: 1 });
  });

  it("a sweep of the healthy mailbox is not reported dirty for the broken one (M2)", async () => {
    const { router } = setup(broken);
    const c = ctx(router, { contactId: PRINCIPAL, mailbox: 'work' });
    (c.contactService!.getCalendarsForContact as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const data = dataOf(await run(new CalendarHoldsSweepHandler(), c));
    expect(data['calendarErrors']).toBe(0);
  });
});

describe('fix round 1: evidence is best-effort after a booking (R85)', () => {
  it('a slow evidence call is left out and the booking is still a success', async () => {
    vi.useFakeTimers();
    try {
      const { work, router } = setup({ evidence: () => new Promise(() => undefined) });
      const pending = run(new CalendarCreateEventHandler(), ctx(router, {
        calendarId: 'primary', title: 'T', start: START, end: END, mailbox: 'work', attendees: [{ email: 'x@y.example.org' }],
      }));
      await vi.advanceTimersByTimeAsync(6_000);
      const data = dataOf(await pending);
      expect(work.createEvent).toHaveBeenCalledTimes(1);
      expect(data['evidence_unavailable']).toBe(true);
      expect(data).not.toHaveProperty('evidence');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fix round 1: collapse rules (R82, M1)', () => {
  const listInput = { contactId: PRINCIPAL, timeMin: START, timeMax: END };
  const system = { taskMetadata: { originator: { systemRole: 'system' } } } as Partial<ToolContext>;

  it('a spoofed UID on an invite with another title or time stays a separate entry', async () => {
    const { work, personal, router } = setup();
    work.listEvents.mockResolvedValue([event('w-1', 'cal-work', { icalUid: 'uid-1', title: 'Board' })]);
    personal.listEvents.mockResolvedValue([
      event('p-1', 'cal-personal', { icalUid: 'uid-1', title: 'Totally different' }),
      event('p-2', 'cal-personal', { icalUid: 'uid-1', title: 'Board', endTime: END_UNIX + 1800 }),
    ]);
    const data = dataOf(await run(new CalendarListEventsHandler(), ctx(router, listInput, system)));
    const events = data['events'] as Array<{ id: string; calendars?: unknown }>;
    expect(events.map((e) => e.id)).toEqual(['w-1', 'p-1', 'p-2']);
    expect(events.every((e) => e.calendars === undefined)).toBe(true);
  });

  it('R99: a spoofed copy matching UID, time and title but not organizer, place or link stays its own entry', async () => {
    const base = { icalUid: 'uid-1', title: 'Board', organizerEmail: 'chair@board.example.org', location: 'Room 4', conferencing: { provider: 'Zoom', details: { url: 'https://zoom.example/real' } } };
    for (const spoof of [
      { organizerEmail: 'attacker@evil.example' },
      { location: 'Somewhere else' },
      { conferencing: { provider: 'Zoom', details: { url: 'https://zoom.example/evil' } } },
    ]) {
      const { work, personal, router } = setup();
      work.listEvents.mockResolvedValue([event('w-1', 'cal-work', { ...base, ...spoof })]);
      personal.listEvents.mockResolvedValue([event('p-1', 'cal-personal', base)]);
      const data = dataOf(await run(new CalendarListEventsHandler(), ctx(router, listInput, system)));
      const events = data['events'] as Array<{ id: string; calendars?: unknown }>;
      expect(events.map((e) => e.id), JSON.stringify(spoof)).toEqual(['w-1', 'p-1']);
      expect(events.every((e) => e.calendars === undefined)).toBe(true);
    }
    // The real copies (same organizer, place and link, the organizer's case aside) still collapse.
    const { work, personal, router } = setup();
    work.listEvents.mockResolvedValue([event('w-1', 'cal-work', { ...base, organizerEmail: 'Chair@Board.example.org' })]);
    personal.listEvents.mockResolvedValue([event('p-1', 'cal-personal', base)]);
    const data = dataOf(await run(new CalendarListEventsHandler(), ctx(router, listInput, system)));
    expect((data['events'] as unknown[])).toHaveLength(1);
  });

  it('filters run before collapsing: a match on only one copy is listed', async () => {
    const { work, personal, router } = setup();
    work.listEvents.mockResolvedValue([event('w-1', 'cal-work', { icalUid: 'uid-1', title: 'Board' })]);
    personal.listEvents.mockResolvedValue([event('p-1', 'cal-personal', {
      icalUid: 'uid-1', title: 'Board', participants: [{ email: 'chair@board.example.org', name: 'Chair', status: 'yes' }],
    })]);
    const data = dataOf(await run(new CalendarListEventsHandler(), ctx(router, { ...listInput, attendeeEmail: 'chair@board.example.org' }, system)));
    expect((data['events'] as Array<{ id: string }>).map((e) => e.id)).toEqual(['p-1']);
  });

  it("same-mailbox duplicates stay separate whatever else the listing holds", async () => {
    const { work, personal, router } = setup();
    work.listEvents.mockImplementation(async (cal: string) => [event(`${cal}-1`, cal, { icalUid: 'uid-1', title: 'Team' })]);
    personal.listEvents.mockResolvedValue([event('p-unrelated', 'cal-personal', { icalUid: 'uid-9' })]);
    const c = ctx(router, listInput, system);
    (c.contactService!.getCalendarsForContact as ReturnType<typeof vi.fn>).mockResolvedValue([
      { nylasCalendarId: 'cal-work' }, { nylasCalendarId: 'ceo@work.example.com' }, { nylasCalendarId: 'cal-personal' },
    ]);
    const data = dataOf(await run(new CalendarListEventsHandler(), c));
    const events = data['events'] as Array<{ id: string; calendars?: unknown }>;
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.calendars === undefined)).toBe(true);
  });
});

describe('fix round 2: a skipped home pass is visible (N2)', () => {
  it('with several mailboxes, a failed mailbox-list read counts one calendarError', async () => {
    const { router } = setup();
    Object.assign(router, { liveMailboxes: async () => { throw new Error('registry down'); } });
    const c = ctx(router, { contactId: PRINCIPAL });
    (c.contactService!.getCalendarsForContact as ReturnType<typeof vi.fn>).mockResolvedValue([
      { nylasCalendarId: 'cal-work', principalMailboxId: 'work' },
      { nylasCalendarId: 'cal-personal', principalMailboxId: 'personal' },
    ]);
    const data = dataOf(await run(new CalendarHoldsSweepHandler(), c));
    expect(data['calendarErrors']).toBe(1);
  });
});
