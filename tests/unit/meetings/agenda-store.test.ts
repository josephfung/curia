import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '../../../src/logger.js';
import { AgendaStore, parseAgendaDoc } from '../../../src/meetings/agenda-store.js';
import type { ParkAgendaInput } from '../../../src/meetings/types.js';
import { memoryWorkingDocsRepo } from './memory-working-docs-repo.js';

const NOW = new Date('2026-11-20T15:00:00.000Z');
const OWNER = '7e1f4c2a-5b3d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function input(overrides: Partial<ParkAgendaInput> = {}) {
  return {
    title: 'Session',
    topics: ['Topic'],
    context: 'Context.',
    source: 'coordinator' as const,
    sensitivity: 'internal' as const,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

describe('AgendaStore supersede', () => {
  it('parking a new agenda for the same owner closes the old pending one', async () => {
    const store = new AgendaStore(memoryWorkingDocsRepo(NOW), createSilentLogger());
    const old = await store.park(input({ ownerTaskId: OWNER, calendarEventId: 'evt-1', calendarId: 'cal-1' }), NOW);
    const other = await store.park(input({ ownerTaskId: OTHER }), NOW);
    const untied = await store.park(input(), NOW);

    const next = await store.park(input({ ownerTaskId: OWNER, calendarEventId: 'evt-2', calendarId: 'cal-1' }), NOW);

    expect(await store.get(old.agendaId)).toBeNull();
    const pending = (await store.listPending(NOW)).map((a) => a.agendaId).sort();
    expect(pending).toEqual([next.agendaId, other.agendaId, untied.agendaId].sort());
  });
});

describe('AgendaStore concurrent parks for one owner', () => {
  it('leaves the newest agenda pending when two parks for the same owner run at once', async () => {
    const store = new AgendaStore(memoryWorkingDocsRepo(NOW), createSilentLogger());
    const [a, b] = await Promise.all([
      store.park(input({ ownerTaskId: OWNER, title: 'A' }), NOW),
      store.park(input({ ownerTaskId: OWNER, title: 'B' }), NOW),
    ]);
    const pending = (await store.listPending(NOW)).map((x) => x.agendaId);
    // Queued: A parks first, then B supersedes it. Never zero pending.
    expect(pending).toEqual([b.agendaId]);
    expect(await store.get(a.agendaId)).toBeNull();
  });

  it('a failed park does not block the next park for the owner', async () => {
    const repo = memoryWorkingDocsRepo(NOW);
    const create = repo.create.bind(repo);
    let fail = true;
    (repo as { create: typeof repo.create }).create = async (p) => {
      if (fail) { fail = false; throw new Error('db down'); }
      return create(p);
    };
    const store = new AgendaStore(repo, createSilentLogger());
    const [first, second] = await Promise.allSettled([
      store.park(input({ ownerTaskId: OWNER }), NOW),
      store.park(input({ ownerTaskId: OWNER }), NOW),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });
});

describe('AgendaStore close when the archive step fails', () => {
  it('returns the closed agenda, and the next cull archives it', async () => {
    const repo = memoryWorkingDocsRepo(NOW);
    const store = new AgendaStore(repo, createSilentLogger());
    const parked = await store.park(input({ ownerTaskId: OWNER, calendarEventId: 'evt-1', calendarId: 'cal-1' }), NOW);
    const softDelete = repo.softDeleteAtVersion.bind(repo);
    (repo as { softDeleteAtVersion: typeof repo.softDeleteAtVersion }).softDeleteAtVersion = async () => {
      throw new Error('archive failed');
    };

    const closed = await store.close(parked.agendaId, { eventState: 'cancelled' });

    expect(closed?.status).toBe('done');
    expect(closed?.eventState).toBe('cancelled');
    expect(await store.listPending(NOW)).toEqual([]);
    (repo as { softDeleteAtVersion: typeof repo.softDeleteAtVersion }).softDeleteAtVersion = softDelete;
    expect(await store.cullExpired(NOW)).toBe(1);
    expect(await store.get(parked.agendaId)).toBeNull();
  });

  it('the cull leaves a done agenda a call still holds to settle', async () => {
    const repo = memoryWorkingDocsRepo(NOW);
    const store = new AgendaStore(repo, createSilentLogger());
    const parked = await store.park(input(), NOW);
    const locked = await store.lock(parked.agendaId, 's-1', NOW);
    expect(locked.ok).toBe(true);
    const held = (await store.get(parked.agendaId))!;
    // As settle leaves it between its done write and its archive.
    await repo.update(held.path, { frontmatter: { ...(await repo.read(held.path))!.frontmatter, status: 'done' }, expectedVersion: held.version });

    expect(await store.cullExpired(NOW)).toBe(0);
    expect(await store.settle(parked.agendaId, 's-1', { kind: 'done' })).toBe('settled');
  });
});

describe('parseAgendaDoc event fields', () => {
  it('ignores a non-UUID owner and an event id without its calendar', async () => {
    const repo = memoryWorkingDocsRepo(NOW);
    const store = new AgendaStore(repo, createSilentLogger());
    const parked = await store.park(input(), NOW);
    const row = (await repo.read(parked.path))!;

    const doc = parseAgendaDoc({ ...row, frontmatter: { ...row.frontmatter, owner_task_id: 'any-task', calendar_event_id: 'evt-1' } });

    expect(doc).not.toBeNull();
    expect(doc!.ownerTaskId).toBeNull();
    expect(doc!.calendarEventId).toBeNull();
    expect(doc!.calendarId).toBeNull();
  });
});
