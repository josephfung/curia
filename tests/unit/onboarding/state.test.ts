import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  createOnboardingStateLock,
  findOpenOnboardingTask,
  readOnboardingState,
  updateOnboardingState,
  writeOnboardingState,
  type OnboardingState,
} from '../../../src/onboarding/state.js';
import { notifyOperator } from '../../../src/onboarding/notify-operator.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';

const logger = pino({ level: 'silent' });

const sample: OnboardingState = {
  taskId: 't1',
  startedAt: '2026-11-20T10:00:00.000Z',
  route: 'app',
  greetingSentAt: null,
  followUpsSent: 0,
  lastFollowUpAt: null,
  lastPrincipalTurnAt: null,
  idleNudgeSentAt: null,
  operatorNotified: [],
};

function fakeStore() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (ns: string, key: string) => data.get(`${ns}/${key}`) ?? null,
    set: async (ns: string, key: string, value: string) => {
      data.set(`${ns}/${key}`, value);
      return { stored: true, action: 'created' };
    },
  };
}

describe('onboarding state', () => {
  it('round-trips through the store', async () => {
    const store = fakeStore();
    await writeOnboardingState(store, sample);
    expect(await readOnboardingState(store)).toEqual(sample);
  });

  it('accepts a null route (a principal start on an install with no messaging route)', async () => {
    const store = fakeStore();
    await writeOnboardingState(store, { ...sample, route: null });
    expect((await readOnboardingState(store))?.route).toBeNull();
  });

  it('returns null when absent and when the JSON is malformed', async () => {
    const store = fakeStore();
    expect(await readOnboardingState(store)).toBeNull();
    store.data.set('onboarding/state', '{not json');
    expect(await readOnboardingState(store, logger)).toBeNull();
  });

  it.each([
    { route: 'carrier-pigeon' },
    { followUpsSent: 'two' },
    { operatorNotified: ['made_up'] },
    { taskId: 5 },
  ])('returns null for a wrongly shaped state %j', async (patch) => {
    const store = fakeStore();
    store.data.set('onboarding/state', JSON.stringify({ ...sample, ...patch }));
    expect(await readOnboardingState(store, logger)).toBeNull();
  });
});

/** A pool whose lock connection records its queries; the in-process queue does the serializing. */
function fakeLockPool() {
  const queries: string[] = [];
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }),
      release,
    })),
  };
  return { pool: pool as never, queries, release };
}

describe('updateOnboardingState', () => {
  it('serializes concurrent read-modify-writes, so neither change is lost', async () => {
    const store = fakeStore();
    await writeOnboardingState(store, sample);
    // Every read yields first, so unlocked updates would both read the original state.
    const slowStore = {
      get: async (ns: string, key: string) => { await new Promise((r) => setTimeout(r, 5)); return store.get(ns, key); },
      set: store.set,
    };
    const deps = { configStore: slowStore, stateLock: createOnboardingStateLock(fakeLockPool().pool, logger), logger };
    await Promise.all([
      updateOnboardingState(deps, (s) => ({ ...s, greetingSentAt: '2026-11-20T11:00:00.000Z' })),
      updateOnboardingState(deps, (s) => ({ ...s, lastPrincipalTurnAt: '2026-11-20T11:01:00.000Z' })),
    ]);
    expect(await readOnboardingState(store)).toMatchObject({
      greetingSentAt: '2026-11-20T11:00:00.000Z',
      lastPrincipalTurnAt: '2026-11-20T11:01:00.000Z',
    });
  });

  it('takes the advisory lock in a transaction and commits it', async () => {
    const store = fakeStore();
    await writeOnboardingState(store, sample);
    const lock = fakeLockPool();
    const out = await updateOnboardingState(
      { configStore: store, stateLock: createOnboardingStateLock(lock.pool, logger) },
      (s) => ({ ...s, followUpsSent: 1 }),
    );
    expect(out).toMatchObject({ written: true, state: { followUpsSent: 1 } });
    expect(lock.queries[0]).toBe('BEGIN');
    expect(lock.queries.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(lock.queries.at(-1)).toBe('COMMIT');
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it('rolls back and rethrows when the update fails, and a later update still runs', async () => {
    const lock = fakeLockPool();
    const stateLock = createOnboardingStateLock(lock.pool, logger);
    const failing = { get: async () => JSON.stringify(sample), set: async () => ({ stored: false, action: 'rejected' }) };
    await expect(updateOnboardingState({ configStore: failing, stateLock }, (s) => ({ ...s, followUpsSent: 1 })))
      .rejects.toThrow(/rejected the onboarding state write/);
    expect(lock.queries.at(-1)).toBe('ROLLBACK');
    const store = fakeStore();
    await writeOnboardingState(store, sample);
    await expect(updateOnboardingState({ configStore: store, stateLock }, (s) => ({ ...s, followUpsSent: 2 })))
      .resolves.toMatchObject({ written: true });
  });

  it('leaves missing state uncreated, and writes nothing when the change declines', async () => {
    const store = fakeStore();
    const deps = { configStore: store, stateLock: createOnboardingStateLock(fakeLockPool().pool, logger) };
    expect(await updateOnboardingState(deps, (s) => s)).toEqual({ state: null, written: false });
    expect(store.data.size).toBe(0);
    await writeOnboardingState(store, sample);
    expect(await updateOnboardingState(deps, () => null)).toEqual({ state: sample, written: false });
  });
});

describe('findOpenOnboardingTask', () => {
  it('returns the open parent and ignores subtasks and terminal tasks', async () => {
    const rows = [
      { id: 'sub', parentTaskId: 'p', status: 'open', createdBy: 'onboarding' },
      { id: 'spoofed', status: 'open', createdBy: 'coordinator' },
      { id: 'parent', status: 'in_progress', createdBy: 'onboarding' },
    ] as unknown as TaskRow[];
    const listTasks = vi.fn(async () => rows as never);
    const found = await findOpenOnboardingTask({ listTasks });
    expect(found?.id).toBe('parent');
    const filters = (listTasks.mock.calls[0] as unknown[])[0] as { tag: string; statuses: string[]; createdBy: string };
    expect(filters.tag).toBe('onboarding');
    // Filtered in the query, so model-tagged tasks cannot crowd the parent off the page.
    expect(filters.createdBy).toBe('onboarding');
    expect(filters.statuses).not.toContain('done');
    expect(filters.statuses).not.toContain('cancelled');
  });

  it('returns null when nothing is open', async () => {
    expect(await findOpenOnboardingTask({ listTasks: async () => [] })).toBeNull();
  });
});

describe('notifyOperator', () => {
  it('writes a progress note and audits', async () => {
    const updateTask = vi.fn(async () => null);
    const audit = vi.fn();
    await expect(
      notifyOperator({ taskRepo: { updateTask }, logger, audit }, 't1', 'greeting_unanswered'),
    ).resolves.toEqual({ recorded: true });
    expect(updateTask).toHaveBeenCalledWith('t1', { progressNote: 'Operator notice: greeting_unanswered' });
    expect(audit).toHaveBeenCalledOnce();
  });

  it('swallows an updateTask rejection, logs an error and reports it unrecorded', async () => {
    const error = vi.spyOn(logger, 'error');
    const updateTask = vi.fn(async () => { throw new Error('db down'); });
    await expect(
      notifyOperator({ taskRepo: { updateTask }, logger }, 't1', 'web_search_failed'),
    ).resolves.toEqual({ recorded: false });
    expect(error).toHaveBeenCalled();
  });

  it('still reports the notice recorded when only the audit throws', async () => {
    const updateTask = vi.fn(async () => null);
    const audit = vi.fn(() => { throw new Error('audit down'); });
    await expect(
      notifyOperator({ taskRepo: { updateTask }, logger, audit }, 't1', 'web_search_failed'),
    ).resolves.toEqual({ recorded: true });
  });
});
