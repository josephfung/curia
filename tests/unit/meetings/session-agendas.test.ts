import { describe, expect, it, vi } from 'vitest';
import type { AgendaStore } from '../../../src/meetings/agenda-store.js';
import {
  prepareCallAgendas,
  prepareSessionAgendas,
  releaseUnstartedPreload,
  withAgendaMetadata,
} from '../../../src/meetings/session-agendas.js';
import type { AgendaDoc } from '../../../src/meetings/types.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { Logger } from '../../../src/logger.js';

const NOW = new Date('2026-10-28T16:00:00.000Z');
const SESSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function agenda(overrides: Partial<AgendaDoc> & { agendaId: string }): AgendaDoc {
  return {
    path: `/meetings/agendas/${overrides.agendaId}.md`,
    version: 1,
    title: 'Weekly',
    topics: ['budget'],
    role: null,
    context: 'Discuss the budget.',
    source: 'principal',
    sensitivity: 'internal',
    scheduledFor: null,
    history: [],
    status: 'pending',
    expiresAt: '2026-11-04T16:00:00.000Z',
    inCallSession: null,
    ...overrides,
  };
}

function fakeStore(impl: {
  cullExpired?: () => Promise<number>;
  listPending?: () => Promise<AgendaDoc[]>;
  lock?: AgendaStore['lock'];
}): { store: AgendaStore; cullExpired: ReturnType<typeof vi.fn>; listPending: ReturnType<typeof vi.fn>; lock: ReturnType<typeof vi.fn> } {
  const cullExpired = vi.fn(impl.cullExpired ?? (async () => 0));
  const listPending = vi.fn(impl.listPending ?? (async () => []));
  const lock = vi.fn(impl.lock ?? (async () => ({ ok: false as const, reason: 'not_found' as const })));
  return { store: { cullExpired, listPending, lock } as unknown as AgendaStore, cullExpired, listPending, lock };
}

function spyLogger(): { logger: Logger; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  const logger = {
    error,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, error };
}

describe('prepareSessionAgendas', () => {
  it('single due agenda is locked and preloaded', async () => {
    const doc = agenda({ agendaId: '11111111-1111-1111-1111-111111111111' });
    const { store, lock } = fakeStore({
      listPending: async () => [doc],
      lock: async () => ({ ok: true, agenda: doc }),
    });

    const result = await prepareSessionAgendas(store, { sessionId: SESSION, now: NOW, logger: createSilentLogger() });

    expect(lock).toHaveBeenCalledWith(doc.agendaId, SESSION, NOW);
    expect(result.preload).toMatchObject({ agendaId: doc.agendaId, loadedAt: NOW.toISOString() });
    expect(result.agendas.loaded).toEqual([expect.objectContaining({ agendaId: doc.agendaId, context: doc.context })]);
    expect(result.agendas.index).toEqual([]);
  });

  it('single not-due agenda goes to the index unlocked', async () => {
    const doc = agenda({
      agendaId: '22222222-2222-2222-2222-222222222222',
      scheduledFor: '2026-11-20T16:00:00.000Z',
    });
    const { store, lock } = fakeStore({ listPending: async () => [doc] });

    const result = await prepareSessionAgendas(store, { sessionId: SESSION, now: NOW, logger: createSilentLogger() });

    expect(lock).not.toHaveBeenCalled();
    expect(result.preload).toBeNull();
    expect(result.agendas.loaded).toEqual([]);
    expect(result.agendas.index).toEqual([{ agendaId: doc.agendaId, title: doc.title, scheduledFor: doc.scheduledFor }]);
  });

  it('one due agenda beside one that is not due stays an unlocked index', async () => {
    const due = agenda({ agendaId: '66666666-6666-6666-6666-666666666666', title: 'Now' });
    const later = agenda({
      agendaId: '77777777-7777-7777-7777-777777777777',
      title: 'Later',
      scheduledFor: '2026-11-20T16:00:00.000Z',
    });
    const { store, lock } = fakeStore({ listPending: async () => [due, later] });

    const result = await prepareSessionAgendas(store, { sessionId: SESSION, now: NOW, logger: createSilentLogger() });

    expect(lock).not.toHaveBeenCalled();
    expect(result.preload).toBeNull();
    expect(result.agendas.loaded).toEqual([]);
    expect(result.agendas.index.map((entry) => entry.agendaId)).toEqual([due.agendaId, later.agendaId]);
  });

  it('several agendas go to the index unlocked', async () => {
    const first = agenda({ agendaId: '33333333-3333-3333-3333-333333333333', title: 'One' });
    const second = agenda({ agendaId: '44444444-4444-4444-4444-444444444444', title: 'Two' });
    const { store, lock } = fakeStore({ listPending: async () => [first, second] });

    const result = await prepareSessionAgendas(store, { sessionId: SESSION, now: NOW, logger: createSilentLogger() });

    expect(lock).not.toHaveBeenCalled();
    expect(result.preload).toBeNull();
    expect(result.agendas.index.map((entry) => entry.agendaId)).toEqual([first.agendaId, second.agendaId]);
  });

  it('lock conflict falls back to the index', async () => {
    const doc = agenda({ agendaId: '55555555-5555-5555-5555-555555555555' });
    const { store } = fakeStore({
      listPending: async () => [doc],
      lock: async () => ({ ok: false, reason: 'conflict' }),
    });

    const result = await prepareSessionAgendas(store, { sessionId: SESSION, now: NOW, logger: createSilentLogger() });

    expect(result.preload).toBeNull();
    expect(result.agendas.loaded).toEqual([]);
    expect(result.agendas.index).toEqual([{ agendaId: doc.agendaId, title: doc.title, scheduledFor: null }]);
  });

  it('store error yields empty agendas', async () => {
    const { store } = fakeStore({
      cullExpired: async () => {
        throw new Error('db down');
      },
    });
    const { logger, error } = spyLogger();

    const result = await prepareSessionAgendas(store, { sessionId: SESSION, now: NOW, logger });

    expect(result).toEqual({ agendas: { loaded: [], index: [] }, preload: null });
    expect(error).toHaveBeenCalled();
  });
});

// #2359: every call route (Signal, console, PWA) goes through these, so the
// principal gate and the metadata shape cannot drift between routes.
describe('prepareCallAgendas', () => {
  it('prepares agendas for the principal', async () => {
    const doc = agenda({ agendaId: '11111111-1111-1111-1111-111111111111' });
    const { store, lock } = fakeStore({
      listPending: async () => [doc],
      lock: async () => ({ ok: true, agenda: doc }),
    });

    const result = await prepareCallAgendas(store, {
      callerSystemRole: 'principal',
      sessionId: SESSION,
      now: NOW,
      logger: createSilentLogger(),
    });

    expect(lock).toHaveBeenCalledWith(doc.agendaId, SESSION, NOW);
    expect(result?.preload).toMatchObject({ agendaId: doc.agendaId });
    expect(result?.agendas.loaded).toEqual([expect.objectContaining({ agendaId: doc.agendaId })]);
  });

  it('never touches the store for anyone other than the principal', async () => {
    const doc = agenda({ agendaId: '11111111-1111-1111-1111-111111111111' });
    const { store, cullExpired, listPending, lock } = fakeStore({
      listPending: async () => [doc],
      lock: async () => ({ ok: true, agenda: doc }),
    });

    const result = await prepareCallAgendas(store, {
      callerSystemRole: null,
      sessionId: SESSION,
      now: NOW,
      logger: createSilentLogger(),
    });

    expect(result).toBeNull();
    expect(cullExpired).not.toHaveBeenCalled();
    expect(listPending).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it('returns null with no store', async () => {
    const result = await prepareCallAgendas(undefined, {
      callerSystemRole: 'principal',
      sessionId: SESSION,
      now: NOW,
      logger: createSilentLogger(),
    });

    expect(result).toBeNull();
  });
});

describe('withAgendaMetadata', () => {
  const preload = {
    agendaId: '11111111-1111-1111-1111-111111111111',
    loadedAt: NOW.toISOString(),
    snapshot: {} as never,
  };

  it('leaves metadata exactly as given when nothing was prepared', () => {
    const metadata = { channel: 'signal' };
    expect(withAgendaMetadata(metadata, null)).toBe(metadata);
    expect(withAgendaMetadata(undefined, null)).toBeUndefined();
  });

  it('records the preload, or an empty list when nothing was preloaded', () => {
    expect(withAgendaMetadata({ channel: 'signal' }, { agendas: { loaded: [], index: [] }, preload }))
      .toEqual({ channel: 'signal', agendas: [preload] });
    expect(withAgendaMetadata(undefined, { agendas: { loaded: [], index: [] }, preload: null }))
      .toEqual({ agendas: [] });
  });

  it('the server-prepared agendas win over a client-supplied agendas key', () => {
    expect(withAgendaMetadata({ agendas: ['forged'] }, { agendas: { loaded: [], index: [] }, preload }))
      .toEqual({ agendas: [preload] });
  });

  it('drops a client-supplied agendas key even when nothing was prepared', () => {
    expect(withAgendaMetadata({ source: 'test', agendas: ['forged'] }, null)).toEqual({ source: 'test' });
  });
});

describe('releaseUnstartedPreload', () => {
  const preload = {
    agendaId: '11111111-1111-1111-1111-111111111111',
    loadedAt: NOW.toISOString(),
    snapshot: {} as never,
  };

  function settleStore(settle: ReturnType<typeof vi.fn>): AgendaStore {
    return { settle } as unknown as AgendaStore;
  }

  it('returns the locked agenda to pending', async () => {
    const settle = vi.fn(async () => 'settled' as const);

    await releaseUnstartedPreload(settleStore(settle), { agendas: { loaded: [], index: [] }, preload }, SESSION, createSilentLogger());

    expect(settle).toHaveBeenCalledWith(preload.agendaId, SESSION, { kind: 'return' });
  });

  it('does nothing when nothing was locked', async () => {
    const settle = vi.fn(async () => 'settled' as const);

    await releaseUnstartedPreload(settleStore(settle), null, SESSION, createSilentLogger());
    await releaseUnstartedPreload(settleStore(settle), { agendas: { loaded: [], index: [] }, preload: null }, SESSION, createSilentLogger());

    expect(settle).not.toHaveBeenCalled();
  });

  it('logs a settle failure instead of masking the original error', async () => {
    const settle = vi.fn(async () => {
      throw new Error('db down');
    });
    const { logger, error } = spyLogger();

    await releaseUnstartedPreload(settleStore(settle), { agendas: { loaded: [], index: [] }, preload }, SESSION, logger);

    expect(error).toHaveBeenCalled();
  });
});
