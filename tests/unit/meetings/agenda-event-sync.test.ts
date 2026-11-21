import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../src/logger.js';
import {
  AgendaEventSync,
  CANCELLED_NOTE,
  type AgendaEventRead,
  EVENT_UNREADABLE,
  EVENT_UNTIMED,
  NO_SHOW_NOTE,
  NUDGE_NOTE,
  readAgendaEvent,
  UNREADABLE_NOTE,
  UNTIMED_NOTE,
} from '../../../src/meetings/agenda-event-sync.js';
import { CalendarRouteError } from '../../../src/channels/calendar/calendar-router.js';
import { prepareSessionAgendas } from '../../../src/meetings/session-agendas.js';
import { memoryWorkingDocsRepo } from './memory-working-docs-repo.js';
import { AgendaStore } from '../../../src/meetings/agenda-store.js';
import type { AgendaHistoryEntry } from '../../../src/meetings/types.js';
import type { CalendarRouter } from '../../../src/channels/calendar/calendar-router.js';

const NOW = new Date('2026-11-20T15:00:00.000Z');
const MIN = 60_000;
const OWNER = '7e1f4c2a-5b3d-4e6f-8a9b-0c1d2e3f4a5b';

async function setup(opts: { start: Date; end?: Date; scheduledFor?: Date | null; owner?: string | null }) {
  const store = new AgendaStore(memoryWorkingDocsRepo(NOW), createSilentLogger());
  const parked = await store.park({
    title: 'Kickoff',
    topics: ['Week ahead'],
    context: 'Plan the week.',
    source: 'routine',
    sensitivity: 'internal',
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * MIN),
    scheduledFor: opts.scheduledFor === undefined ? opts.start : opts.scheduledFor,
    calendarEventId: 'evt-1',
    calendarId: 'cal-1',
    ownerTaskId: opts.owner === undefined ? OWNER : opts.owner,
  }, NOW);
  let event: AgendaEventRead | Error = {
    start: opts.start,
    end: opts.end ?? new Date(opts.start.getTime() + 30 * MIN),
    status: 'confirmed',
  };
  const getEvent = vi.fn(async () => {
    if (event instanceof Error) throw event;
    return event;
  });
  const wakeOwner = vi.fn(async () => {});
  const sync = new AgendaEventSync({ store, getEvent, wakeOwner, logger: createSilentLogger() });
  return {
    store,
    agendaId: parked.agendaId,
    sync,
    wakeOwner,
    getEvent,
    setEvent: (next: AgendaEventRead | Error) => { event = next; },
  };
}

describe('AgendaEventSync', () => {
  it('reschedules the agenda when the event moved', async () => {
    const start = new Date(NOW.getTime() + 3 * 60 * MIN);
    const moved = new Date(NOW.getTime() + 27 * 60 * MIN);
    const t = await setup({ start });
    t.setEvent({ start: moved, end: new Date(moved.getTime() + 30 * MIN), status: 'confirmed' });

    await t.sync.tick(NOW);

    expect((await t.store.get(t.agendaId))!.scheduledFor).toBe(moved.toISOString());
    expect(t.wakeOwner).not.toHaveBeenCalled();
  });

  it('wakes the owner once when the event is cancelled, across two sweeps', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN) });
    t.setEvent({ start: new Date(NOW.getTime() + 3 * 60 * MIN), end: new Date(NOW.getTime() + 4 * 60 * MIN), status: 'cancelled' });

    await t.sync.tick(NOW);
    await t.sync.tick(new Date(NOW.getTime() + 15 * MIN));

    expect(t.wakeOwner).toHaveBeenCalledTimes(1);
    expect(t.wakeOwner).toHaveBeenCalledWith(OWNER, CANCELLED_NOTE);
    // Closed and archived, so it is no longer pending.
    expect(await t.store.get(t.agendaId)).toBeNull();
  });

  it('does not preload a cancelled event-tied agenda onto a later call', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN) });
    t.setEvent(null);
    await t.sync.tick(NOW);

    const prepared = await prepareSessionAgendas(t.store, { sessionId: 's-later', now: new Date(NOW.getTime() + 60 * MIN), logger: createSilentLogger() });

    expect(prepared.preload).toBeNull();
    expect(prepared.agendas.index).toEqual([]);
  });

  it('treats a deleted event (not found) as cancelled', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN) });
    t.setEvent(null);

    await t.sync.tick(NOW);
    await t.sync.tick(new Date(NOW.getTime() + 15 * MIN));

    expect(t.wakeOwner).toHaveBeenCalledTimes(1);
    expect(t.wakeOwner).toHaveBeenCalledWith(OWNER, CANCELLED_NOTE);
  });

  it('skips an agenda whose event read failed transiently, and leaves it for the next sweep', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN) });
    t.setEvent(new Error('socket hang up'));

    await t.sync.tick(NOW);

    expect(t.wakeOwner).not.toHaveBeenCalled();
    expect((await t.store.get(t.agendaId))!.eventState).toBe('scheduled');
  });

  it('wakes the owner once when calendar access is refused, and stops reading the event', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN) });
    t.setEvent(EVENT_UNREADABLE);

    await t.sync.tick(NOW);
    await t.sync.tick(new Date(NOW.getTime() + 15 * MIN));

    expect(t.wakeOwner).toHaveBeenCalledTimes(1);
    expect(t.wakeOwner).toHaveBeenCalledWith(OWNER, UNREADABLE_NOTE);
    expect(t.getEvent).toHaveBeenCalledTimes(1);
    expect((await t.store.get(t.agendaId))!.eventState).toBe('unreadable');
  });

  it('an all-day event wakes the owner once to ask when, and is not read again', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN) });
    t.setEvent(EVENT_UNTIMED);

    await t.sync.tick(NOW);
    await t.sync.tick(new Date(NOW.getTime() + 15 * MIN));

    expect(t.wakeOwner).toHaveBeenCalledTimes(1);
    expect(t.wakeOwner).toHaveBeenCalledWith(OWNER, UNTIMED_NOTE);
    expect(t.getEvent).toHaveBeenCalledTimes(1);
  });

  it('nudges once when the session is about to start', async () => {
    const start = new Date(NOW.getTime() + 10 * MIN);
    const t = await setup({ start });

    await t.sync.tick(NOW);
    await t.sync.tick(new Date(NOW.getTime() + 5 * MIN));

    expect(t.wakeOwner).toHaveBeenCalledTimes(1);
    expect(t.wakeOwner).toHaveBeenCalledWith(OWNER, NUDGE_NOTE);
    expect((await t.store.get(t.agendaId))!.nudgedAt).toBe(NOW.toISOString());
  });

  it('nudges again after the event moves later', async () => {
    const start = new Date(NOW.getTime() + 10 * MIN);
    const t = await setup({ start });
    await t.sync.tick(NOW);

    const moved = new Date(NOW.getTime() + 2 * 60 * MIN);
    t.setEvent({ start: moved, end: new Date(moved.getTime() + 30 * MIN), status: 'confirmed' });
    await t.sync.tick(new Date(NOW.getTime() + 5 * MIN));
    expect((await t.store.get(t.agendaId))!.nudgedAt).toBeNull();

    await t.sync.tick(new Date(moved.getTime() - 5 * MIN));
    expect(t.wakeOwner).toHaveBeenCalledTimes(2);
  });

  it('notices a no-show once', async () => {
    const start = new Date(NOW.getTime() - 2 * 60 * MIN);
    const t = await setup({ start, end: new Date(start.getTime() + 30 * MIN) });

    await t.sync.tick(NOW);
    await t.sync.tick(new Date(NOW.getTime() + 15 * MIN));

    expect(t.wakeOwner).toHaveBeenCalledTimes(1);
    expect(t.wakeOwner).toHaveBeenCalledWith(OWNER, NO_SHOW_NOTE);
    expect((await t.store.get(t.agendaId))!.eventState).toBe('no_show');
  });

  it('still preloads a no-show agenda onto a call 20 hours after the event', async () => {
    const start = new Date(NOW.getTime() - 2 * 60 * MIN);
    const t = await setup({ start, end: new Date(start.getTime() + 30 * MIN) });
    await t.sync.tick(NOW);

    const prepared = await prepareSessionAgendas(t.store, { sessionId: 's-late', now: new Date(start.getTime() + 20 * 60 * MIN), logger: createSilentLogger() });

    expect(prepared.preload?.agendaId).toBe(t.agendaId);
  });

  it('does not count a no-show when a call loaded the agenda', async () => {
    const start = new Date(NOW.getTime() - 2 * 60 * MIN);
    const t = await setup({ start, end: new Date(start.getTime() + 30 * MIN) });
    const history: AgendaHistoryEntry = { sessionId: 's-1', date: start.toISOString(), topics: [{ topic: 'Week ahead', coverage: 'partial' }] };
    const locked = await t.store.lock(t.agendaId, 's-1', NOW);
    expect(locked.ok).toBe(true);
    await t.store.settle(t.agendaId, 's-1', { kind: 'return', history });

    await t.sync.tick(NOW);

    expect(t.wakeOwner).not.toHaveBeenCalled();
    expect((await t.store.get(t.agendaId))!.eventState).toBe('scheduled');
  });

  it('marks an agenda with no owner task but wakes nothing', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN), owner: null });
    t.setEvent(null);

    await t.sync.tick(NOW);

    expect(t.wakeOwner).not.toHaveBeenCalled();
    expect(await t.store.get(t.agendaId)).toBeNull();
  });
});

describe('readAgendaEvent', () => {
  const routerWith = (getEvent: () => Promise<unknown>, routeErr?: Error) => ({
    route: vi.fn(async () => {
      if (routeErr) throw routeErr;
      return { mailboxId: 'm1', calendarId: 'cal-1', client: { getEvent }, placedBy: 'owner' };
    }),
  }) as unknown as Pick<CalendarRouter, 'route'>;
  const status = (code: number) => Object.assign(new Error('nylas'), { statusCode: code });

  it('reads a timed event', async () => {
    const r = routerWith(async () => ({ startTime: 1_700_000_000, endTime: 1_700_001_800, status: 'confirmed' }));
    expect(await readAgendaEvent(r, 'cal-1', 'evt-1')).toEqual({
      start: new Date(1_700_000_000_000), end: new Date(1_700_001_800_000), status: 'confirmed',
    });
  });

  it('an all-day event is untimed; a gone event is null; refused access is unreadable', async () => {
    expect(await readAgendaEvent(routerWith(async () => ({ startTime: null, endTime: null, status: 'confirmed' })), 'c', 'e')).toBe(EVENT_UNTIMED);
    expect(await readAgendaEvent(routerWith(async () => { throw status(404); }), 'c', 'e')).toBeNull();
    expect(await readAgendaEvent(routerWith(async () => { throw status(403); }), 'c', 'e')).toBe(EVENT_UNREADABLE);
    await expect(readAgendaEvent(routerWith(async () => { throw status(503); }), 'c', 'e')).rejects.toThrow('nylas');
  });

  it('a calendar that no longer routes is unreadable; an unconfirmed owner is retried', async () => {
    const removed = new CalendarRouteError('mailbox_removed', 'gone');
    expect(await readAgendaEvent(routerWith(async () => null, removed), 'c', 'e')).toBe(EVENT_UNREADABLE);
    const unconfirmed = new CalendarRouteError('owner_unconfirmed', 'try again');
    await expect(readAgendaEvent(routerWith(async () => null, unconfirmed), 'c', 'e')).rejects.toThrow('try again');
  });
});
