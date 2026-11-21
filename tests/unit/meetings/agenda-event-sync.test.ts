import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../src/logger.js';
import {
  AgendaEventSync,
  type AgendaCalendarEvent,
  CANCELLED_NOTE,
  EVENT_UNREADABLE,
  NO_SHOW_NOTE,
  NUDGE_NOTE,
  UNREADABLE_NOTE,
} from '../../../src/meetings/agenda-event-sync.js';
import { prepareSessionAgendas } from '../../../src/meetings/session-agendas.js';
import { memoryWorkingDocsRepo } from './memory-working-docs-repo.js';
import { AgendaStore } from '../../../src/meetings/agenda-store.js';
import type { AgendaHistoryEntry } from '../../../src/meetings/types.js';

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
  let event: AgendaCalendarEvent | null | Error | typeof EVENT_UNREADABLE = {
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
    setEvent: (next: AgendaCalendarEvent | null | Error | typeof EVENT_UNREADABLE) => { event = next; },
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
