// CalendarRouter (#2475, D7): each calendar call goes through the mailbox it belongs to.
import { describe, it, expect, vi } from 'vitest';
import { CalendarRouteError } from '../../../../src/channels/calendar/calendar-router.js';
import {
  calendarMailbox,
  routerFixture,
  type RouterFixture,
} from '../../../../skills/_shared/calendar-router-test-helpers.js';

const work = calendarMailbox('work', 'Work', 'ceo@work.example.com', true);
const personal = calendarMailbox('personal', 'Personal', 'ceo@personal.example.com');

function client(name: string, calendars: Array<{ id: string; isPrimary: boolean }> = []) {
  return { name, listCalendars: vi.fn().mockResolvedValue(calendars) };
}

function twoMailboxes(extra: Partial<RouterFixture> = {}) {
  const clients = { work: client('work'), personal: client('personal') };
  return { clients, router: routerFixture({ mailboxes: [work, personal], clients, ...extra }) };
}

async function routeError(p: Promise<unknown>): Promise<CalendarRouteError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CalendarRouteError);
  return err as CalendarRouteError;
}

describe('CalendarRouter.route', () => {
  it('routes a registered calendar to its mailbox', async () => {
    const { clients, router } = twoMailboxes({ registry: { 'team@group.calendar.google.com': { principalMailboxId: 'personal' } } });
    const r = await router.route('team@group.calendar.google.com');
    expect(r.mailboxId).toBe('personal');
    expect(r.calendarId).toBe('team@group.calendar.google.com');
    expect(r.client).toBe(clients.personal);
  });

  it('a registered calendar goes through its own mailbox, not the hint', async () => {
    const { clients, router } = twoMailboxes({ registry: { 'cal-x': { principalMailboxId: 'personal' } } });
    expect((await router.route('cal-x', 'work')).client).toBe(clients.personal);
  });

  it('an unregistered calendar needs a mailbox when two exist', async () => {
    const { router } = twoMailboxes();
    const err = await routeError(router.route('team@group.calendar.google.com'));
    expect(err.code).toBe('needs_mailbox');
    expect(err.mailboxes).toEqual([{ id: 'work', label: 'Work' }, { id: 'personal', label: 'Personal' }]);
    expect(err.message).toContain('pass mailbox as one of: work (Work), personal (Personal)');
  });

  it('an unregistered calendar goes through the named mailbox', async () => {
    const { clients, router } = twoMailboxes();
    const r = await router.route('team@group.calendar.google.com', 'personal');
    expect(r).toMatchObject({ mailboxId: 'personal', calendarId: 'team@group.calendar.google.com' });
    expect(r.client).toBe(clients.personal);
  });

  it('a row the backfill has not assigned yet counts as unregistered', async () => {
    const { router } = twoMailboxes({ registry: { 'cal-x': { principalMailboxId: null } } });
    expect((await routeError(router.route('cal-x'))).code).toBe('needs_mailbox');
    expect((await router.route('cal-x', 'work')).mailboxId).toBe('work');
  });

  it('with one live mailbox an unregistered calendar goes through it, as before Part 4', async () => {
    const c = client('work');
    const router = routerFixture({ clients: { work: c } });
    const r = await router.route('someone@example.org');
    expect(r).toMatchObject({ mailboxId: 'work', calendarId: 'someone@example.org' });
    expect(r.client).toBe(c);
  });

  it('owning grant wins: a mailbox address routes to that mailbox over its registry row and the hint', async () => {
    const { clients, router } = twoMailboxes({ registry: { 'ceo@personal.example.com': { principalMailboxId: 'work' } } });
    const r = await router.route('CEO@Personal.example.com', 'work');
    expect(r.mailboxId).toBe('personal');
    expect(r.client).toBe(clients.personal);
  });

  it('refuses bare primary when two mailboxes are live', async () => {
    const { clients, router } = twoMailboxes();
    const err = await routeError(router.route('primary'));
    expect(err.code).toBe('primary_alias_needs_mailbox');
    expect(err.message).toContain('pass mailbox');
    expect(clients.work.listCalendars).not.toHaveBeenCalled();
  });

  it("rewrites primary with a mailbox to that mailbox's home calendar", async () => {
    const { clients, router } = twoMailboxes({
      principalCalendars: [
        { nylasCalendarId: 'ceo@work.example.com', isPrimary: true, principalMailboxId: 'work' },
        { nylasCalendarId: 'ceo@personal.example.com', isPrimary: true, principalMailboxId: 'personal' },
      ],
    });
    const r = await router.route('primary', 'personal');
    expect(r).toMatchObject({ mailboxId: 'personal', calendarId: 'ceo@personal.example.com' });
    expect(r.client).toBe(clients.personal);
  });

  it("rewrites primary to the grant's own primary calendar when no home calendar is registered", async () => {
    const personalClient = client('personal', [{ id: 'other', isPrimary: false }, { id: 'real-home-id', isPrimary: true }]);
    const router = routerFixture({ mailboxes: [work, personal], clients: { work: client('work'), personal: personalClient } });
    expect((await router.route('primary', 'personal')).calendarId).toBe('real-home-id');
  });

  it('says so when a grant has no primary calendar to stand for primary', async () => {
    const router = routerFixture({ mailboxes: [work, personal], clients: { work: client('work'), personal: client('personal') } });
    expect((await routeError(router.route('primary', 'personal'))).code).toBe('no_home_calendar');
  });

  it('primary with one live mailbox goes to its home calendar', async () => {
    const router = routerFixture({ clients: { work: client('work', [{ id: 'home-id', isPrimary: true }]) } });
    expect((await router.route('primary')).calendarId).toBe('home-id');
  });

  it('refuses a calendar whose mailbox was removed, never routing it elsewhere', async () => {
    const router = routerFixture({ clients: { work: client('work') }, removed: { old: 'Old' }, registry: { 'cal-old': { principalMailboxId: 'old' } } });
    const err = await routeError(router.route('cal-old'));
    expect(err.code).toBe('mailbox_removed');
    // The way back (R77): re-register through a live mailbox, named.
    expect(err.message).toContain('re-register it with calendar-register');
    expect(err.message).toContain('work (Work)');
    expect(err.mailboxes).toEqual([{ id: 'work', label: 'Work' }]);
  });

  it('refuses an unknown or removed mailbox hint', async () => {
    const router = routerFixture({ clients: { work: client('work') }, removed: { old: 'Old' } });
    expect((await routeError(router.route('cal-1', 'nope'))).code).toBe('unknown_mailbox');
    expect((await routeError(router.route('cal-1', 'old'))).code).toBe('mailbox_removed');
  });

  it('says no mailbox is connected when none is live', async () => {
    const router = routerFixture({ mailboxes: [], clients: {} });
    expect((await routeError(router.route('cal-1'))).code).toBe('no_mailbox');
  });
});

describe('CalendarRouter.homeCalendars', () => {
  it("lists every live mailbox's home calendar and a removed mailbox's as removed", async () => {
    const workClient = client('work', [{ id: 'grant-home-work', isPrimary: true }]);
    const router = routerFixture({
      mailboxes: [work, personal],
      removed: { old: 'Old' },
      clients: { work: workClient, personal: client('personal') },
      principalCalendars: [
        { nylasCalendarId: 'ceo@personal.example.com', isPrimary: true, principalMailboxId: 'personal' },
        { nylasCalendarId: 'old-home', isPrimary: true, principalMailboxId: 'old' },
        { nylasCalendarId: 'not-home', isPrimary: false, principalMailboxId: 'old' },
      ],
    });
    const homes = await router.homeCalendars();
    expect(homes.map(({ mailboxId, calendarId, label, removed }) => ({ mailboxId, calendarId, label, removed }))).toEqual([
      { mailboxId: 'work', calendarId: 'grant-home-work', label: 'Work', removed: false },
      { mailboxId: 'personal', calendarId: 'ceo@personal.example.com', label: 'Personal', removed: false },
      { mailboxId: 'old', calendarId: 'old-home', label: 'Old', removed: true },
    ]);
    expect(homes[0]!.client).toBe(workClient);
    expect(homes[2]!.client).toBeNull();
  });
});

describe('CalendarRouter.registrationMailbox', () => {
  it('owner first, then the hint, then the sole mailbox', async () => {
    const { router } = twoMailboxes();
    expect(await router.registrationMailbox('ceo@work.example.com', 'personal')).toEqual({ mailboxId: 'work', owner: true });
    expect(await router.registrationMailbox('cal-x', 'personal')).toEqual({ mailboxId: 'personal', owner: false });
    expect((await routeError(router.registrationMailbox('cal-x'))).code).toBe('needs_mailbox');
  });

  it('null while the deferred-migration fallback is served (no registry row to reference)', async () => {
    const router = routerFixture({ clients: { work: client('work') }, fallbackActive: true });
    expect(await router.registrationMailbox('cal-x')).toEqual({ mailboxId: null, owner: false });
  });
});
