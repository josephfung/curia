import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { OnboardingWatcher } from '../../../src/onboarding/watcher.js';
import { readOnboardingState, writeOnboardingState, type OnboardingState } from '../../../src/onboarding/state.js';
import { GREETING_FOLLOWUP_GAP_HOURS, ONBOARDING_CREATED_BY } from '../../../src/onboarding/constants.js';

const logger = pino({ level: 'silent' });
const START = new Date('2026-11-20T10:00:00Z');
const baseState: OnboardingState = {
  taskId: 't1',
  startedAt: START.toISOString(),
  route: 'app',
  greetingSentAt: START.toISOString(),
  followUpsSent: 0,
  lastFollowUpAt: null,
  lastPrincipalTurnAt: null,
  idleNudgeSentAt: null,
  operatorNotified: [],
};
const later = new Date(START.getTime() + GREETING_FOLLOWUP_GAP_HOURS * 3_600_000);
const parent = { id: 't1', status: 'open', tags: ['onboarding'], parentTaskId: null, createdBy: ONBOARDING_CREATED_BY };

function setup(opts: { open: boolean; state?: Partial<OnboardingState>; invitation?: { expiresAt: Date; createdAt: Date; redeemed: boolean } | null }) {
  const data = new Map<string, string>();
  const get = vi.fn(async (ns: string, k: string) => data.get(`${ns}/${k}`) ?? null);
  const set = vi.fn(async (ns: string, k: string, v: string) => {
    data.set(`${ns}/${k}`, v);
    return { stored: true, action: 'created' };
  });
  const configStore = { get, set };
  const taskRepo = {
    listTasks: vi.fn(async (f: { tag?: string; parentTaskId?: string }) => (f.parentTaskId ? [] : opts.open ? [parent] : [])),
    updateTask: vi.fn(async () => undefined),
  };
  const enqueueTaskWake = vi.fn(async () => ({ jobId: 'j1' }));
  const readInvitation = vi.fn(async () => opts.invitation ?? null);
  const watcher = new OnboardingWatcher({
    taskRepo: taskRepo as never,
    scheduler: { enqueueTaskWake },
    configStore,
    logger,
    readInvitation,
  });
  const seed = () => writeOnboardingState(configStore, { ...baseState, ...opts.state });
  return { watcher, get, set, enqueueTaskWake, taskRepo, readInvitation, seed, configStore };
}

describe('OnboardingWatcher.tick', () => {
  it('does nothing when no onboarding task is open', async () => {
    const t = setup({ open: false });
    await t.watcher.tick(later);
    expect(t.get).not.toHaveBeenCalled();
    expect(t.set).not.toHaveBeenCalled();
    expect(t.enqueueTaskWake).not.toHaveBeenCalled();
    expect(t.readInvitation).not.toHaveBeenCalled();
  });

  it('a due follow-up writes state once and wakes once', async () => {
    const t = setup({ open: true });
    await t.seed();
    t.set.mockClear();
    await t.watcher.tick(later);
    expect(t.set).toHaveBeenCalledTimes(1);
    expect(t.enqueueTaskWake).toHaveBeenCalledTimes(1);
    expect((await readOnboardingState(t.configStore))?.followUpsSent).toBe(1);
  });

  it('skips the action when a reply lands between the reads', async () => {
    const t = setup({ open: true });
    await t.seed();
    t.set.mockClear();
    // The tick's first read is stale (no reply); the re-read before the write sees the reply.
    const stale = JSON.stringify(baseState);
    const fresh = JSON.stringify({ ...baseState, lastPrincipalTurnAt: new Date(START.getTime() + 3_600_000).toISOString() });
    let n = 0;
    t.get.mockImplementation(async (ns, k) => (k === 'state' ? (++n === 1 ? stale : fresh) : null));
    await t.watcher.tick(later);
    expect(t.set).not.toHaveBeenCalled();
    expect(t.enqueueTaskWake).not.toHaveBeenCalled();
  });

  describe('invitation staleness', () => {
    const expired = (createdAt: Date) => ({ expiresAt: new Date(createdAt.getTime() + 1000), createdAt, redeemed: false });
    const preGreeting = { greetingSentAt: null };

    it('notifies for an expired invitation minted during this run', async () => {
      const t = setup({ open: true, state: preGreeting, invitation: expired(new Date(START.getTime() + 1000)) });
      await t.seed();
      await t.watcher.tick(later);
      expect((await readOnboardingState(t.configStore))?.operatorNotified).toContain('invitation_expired');
    });

    it('ignores an invitation minted before this run started', async () => {
      const t = setup({ open: true, state: preGreeting, invitation: expired(new Date(START.getTime() - 3_600_000)) });
      await t.seed();
      await t.watcher.tick(later);
      expect((await readOnboardingState(t.configStore))?.operatorNotified).toEqual([]);
    });

    it('ignores the invitation off the app route', async () => {
      const t = setup({ open: true, state: { ...preGreeting, route: 'signal' }, invitation: expired(new Date(START.getTime() + 1000)) });
      await t.seed();
      await t.watcher.tick(later);
      expect(t.readInvitation).not.toHaveBeenCalled();
      expect((await readOnboardingState(t.configStore))?.operatorNotified).toEqual([]);
    });
  });
});
