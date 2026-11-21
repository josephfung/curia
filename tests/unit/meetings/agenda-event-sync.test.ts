import { describe, expect, it, vi } from 'vitest';
import type { WorkingDocRow, WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';
import { createSilentLogger } from '../../../src/logger.js';
import {
  AgendaEventSync,
  type AgendaCalendarEvent,
  CANCELLED_NOTE,
  NO_SHOW_NOTE,
  NUDGE_NOTE,
} from '../../../src/meetings/agenda-event-sync.js';
import { AgendaStore } from '../../../src/meetings/agenda-store.js';
import type { AgendaHistoryEntry } from '../../../src/meetings/types.js';

const NOW = new Date('2026-11-20T15:00:00.000Z');
const MIN = 60_000;
const OWNER = '7e1f4c2a-5b3d-4e6f-8a9b-0c1d2e3f4a5b';

/** In-memory stand-in for the working-docs table: enough of it for AgendaStore. */
function memoryRepo(): WorkingDocsRepo {
  const rows = new Map<string, WorkingDocRow>();
  const row = (path: string, type: string, frontmatter: Record<string, unknown>, body: string, version: number): WorkingDocRow => ({
    id: path, path, type, frontmatter, body, version, sectionVersions: {}, byteSize: body.length,
    taskId: null, conversationId: null, agentId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), archivedAt: null,
  });
  const repo = {
    async create(p: { path: string; type: string; frontmatter?: Record<string, unknown>; body?: string }) {
      const created = row(p.path, p.type, structuredClone(p.frontmatter ?? {}), p.body ?? '', 1);
      rows.set(p.path, created);
      return created;
    },
    async read(path: string) {
      return rows.get(path) ?? null;
    },
    async listByPrefix(prefix: string) {
      return [...rows.values()].filter((r) => r.path.startsWith(prefix));
    },
    async update(path: string, p: { type?: string; frontmatter?: Record<string, unknown>; expectedVersion: number }) {
      const current = rows.get(path)!;
      if (current.version !== p.expectedVersion) return { ok: false as const, conflict: true as const, document: current };
      const next = row(path, p.type ?? current.type, structuredClone(p.frontmatter ?? current.frontmatter), current.body, current.version + 1);
      rows.set(path, next);
      return { ok: true as const, document: next };
    },
    async softDeleteAtVersion(path: string) {
      const current = rows.get(path);
      rows.delete(path);
      return current ? { ok: true as const, document: current } : null;
    },
  };
  return repo as unknown as WorkingDocsRepo;
}

async function setup(opts: { start: Date; end?: Date; scheduledFor?: Date | null; owner?: string | null }) {
  const store = new AgendaStore(memoryRepo(), createSilentLogger());
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
  let event: AgendaCalendarEvent | null | Error = {
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
    setEvent: (next: AgendaCalendarEvent | null | Error) => { event = next; },
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
    expect((await t.store.get(t.agendaId))!.eventState).toBe('cancelled');
  });

  it('treats a deleted event (not found) as cancelled', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN) });
    t.setEvent(null);

    await t.sync.tick(NOW);
    await t.sync.tick(new Date(NOW.getTime() + 15 * MIN));

    expect(t.wakeOwner).toHaveBeenCalledTimes(1);
    expect(t.wakeOwner).toHaveBeenCalledWith(OWNER, CANCELLED_NOTE);
  });

  it('skips an agenda whose event could not be read, and leaves it for the next sweep', async () => {
    const t = await setup({ start: new Date(NOW.getTime() + 3 * 60 * MIN) });
    t.setEvent(new Error('grant revoked'));

    await t.sync.tick(NOW);

    expect(t.wakeOwner).not.toHaveBeenCalled();
    expect((await t.store.get(t.agendaId))!.eventState).toBe('scheduled');
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
    expect((await t.store.get(t.agendaId))!.eventState).toBe('cancelled');
  });
});
