import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  findOpenOnboardingTask,
  readOnboardingState,
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

  it('returns null when absent and when the JSON is malformed', async () => {
    const store = fakeStore();
    expect(await readOnboardingState(store)).toBeNull();
    store.data.set('onboarding/state', '{not json');
    expect(await readOnboardingState(store, logger)).toBeNull();
  });
});

describe('findOpenOnboardingTask', () => {
  it('returns the open parent and ignores subtasks and terminal tasks', async () => {
    const rows = [
      { id: 'sub', parentTaskId: 'p', status: 'open' },
      { id: 'parent', status: 'in_progress' },
    ] as unknown as TaskRow[];
    const listTasks = vi.fn(async () => rows as never);
    const found = await findOpenOnboardingTask({ listTasks });
    expect(found?.id).toBe('parent');
    const filters = (listTasks.mock.calls[0] as unknown[])[0] as { tag: string; statuses: string[] };
    expect(filters.tag).toBe('onboarding');
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
    await notifyOperator({ taskRepo: { updateTask }, logger, audit }, 't1', 'greeting_unanswered');
    expect(updateTask).toHaveBeenCalledWith('t1', { progressNote: 'Operator notice: greeting_unanswered' });
    expect(audit).toHaveBeenCalledOnce();
  });

  it('swallows an updateTask rejection and logs an error', async () => {
    const error = vi.spyOn(logger, 'error');
    const updateTask = vi.fn(async () => { throw new Error('db down'); });
    await expect(
      notifyOperator({ taskRepo: { updateTask }, logger }, 't1', 'web_search_failed'),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
