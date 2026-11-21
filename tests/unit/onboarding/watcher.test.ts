import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { GREETING_NOT_RECORDED_NOTE, isNextSessionBooked, OnboardingWatcher } from '../../../src/onboarding/watcher.js';
import { readOnboardingState, writeOnboardingState, type OnboardingState } from '../../../src/onboarding/state.js';
import { GREETING_FOLLOWUP_GAP_HOURS, ONBOARDING_CREATED_BY } from '../../../src/onboarding/constants.js';
import { TaskTerminalStateError } from '../../../src/db/task-repo.js';

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
  invitationId: 'inv-run',
  operatorNotified: [],
};
const later = new Date(START.getTime() + GREETING_FOLLOWUP_GAP_HOURS * 3_600_000);
const parent = { id: 't1', status: 'open', tags: ['onboarding'], parentTaskId: null, createdBy: ONBOARDING_CREATED_BY };
const openTopic = {
  id: 'sub1', status: 'open', parentTaskId: 't1', createdBy: ONBOARDING_CREATED_BY,
  tags: ['onboarding', 'onboarding:topic:style', 'onboarding:session:first-conversation'],
};

type Invitation = { id: string; expiresAt: Date; redeemed: boolean; redeemedAt?: Date | null };

function setup(opts: {
  open: boolean;
  state?: Partial<OnboardingState>;
  invitation?: Invitation | null;
  openTopic?: boolean;
  booked?: boolean;
  parent?: Partial<typeof parent> & { waitingOnContactId?: string | null };
  topic?: Partial<typeof openTopic> & { waitingOnContactId?: string | null };
  updateTask?: (id: string) => Promise<unknown>;
}) {
  const data = new Map<string, string>();
  const get = vi.fn(async (ns: string, k: string) => data.get(`${ns}/${k}`) ?? null);
  const set = vi.fn(async (ns: string, k: string, v: string) => {
    data.set(`${ns}/${k}`, v);
    return { stored: true, action: 'created' };
  });
  const configStore = { get, set };
  const taskRepo = {
    listTasks: vi.fn(async (f: { tag?: string; parentTaskId?: string }) =>
      f.parentTaskId ? (opts.openTopic ? [{ ...openTopic, ...opts.topic }] : []) : opts.open ? [{ ...parent, ...opts.parent }] : []),
    updateTask: vi.fn(opts.updateTask ?? (async () => undefined)),
  };
  const enqueueTaskWake = vi.fn(async () => ({ jobId: 'j1' }));
  const readInvitation = vi.fn(async () => (opts.invitation ? { redeemedAt: null, ...opts.invitation } : null));
  const nextSessionBooked = vi.fn(async () => opts.booked ?? false);
  const watcher = new OnboardingWatcher({
    taskRepo: taskRepo as never,
    scheduler: { enqueueTaskWake, runTaskWakeEarly: vi.fn(async () => false) },
    configStore,
    stateLock: (fn) => fn(),
    logger,
    readInvitation,
    nextSessionBooked,
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

  it('sets a resumed onboarding task back to waiting on the principal, and leaves a waiting one alone', async () => {
    const resumed = setup({
      open: true,
      parent: { status: 'in_progress', waitingOnContactId: 'c-principal' },
      openTopic: true,
      topic: { status: 'in_progress', waitingOnContactId: 'c-principal' },
    });
    await resumed.watcher.tick(START);
    const reparked = resumed.taskRepo.updateTask.mock.calls as unknown as Array<[string, unknown]>;
    expect(reparked.map(([id, u]) => [id, u])).toEqual([['t1', { status: 'waiting' }], ['sub1', { status: 'waiting' }]]);

    const waiting = setup({ open: true, parent: { status: 'waiting', waitingOnContactId: 'c-principal' } });
    await waiting.watcher.tick(START);
    expect(waiting.taskRepo.updateTask).not.toHaveBeenCalled();
  });

  it('a task that ended mid-tick is skipped quietly, not logged as an error', async () => {
    const t = setup({
      open: true,
      parent: { status: 'in_progress', waitingOnContactId: 'c-principal' },
      updateTask: async () => { throw new TaskTerminalStateError('done'); },
    });
    const error = vi.spyOn(logger, 'error');
    await t.watcher.tick(START);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
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

  it('re-wakes the task once when no greeting was recorded a gap after redemption', async () => {
    const redeemedAt = new Date(START.getTime() + 3_600_000);
    const t = setup({
      open: true,
      state: { greetingSentAt: null },
      invitation: { id: 'inv-run', expiresAt: new Date(START.getTime() + 48 * 3_600_000), redeemed: true, redeemedAt },
    });
    await t.seed();
    const due = new Date(redeemedAt.getTime() + GREETING_FOLLOWUP_GAP_HOURS * 3_600_000);
    await t.watcher.tick(due);
    await t.watcher.tick(new Date(due.getTime() + 15 * 60_000));
    expect(t.enqueueTaskWake).toHaveBeenCalledTimes(1);
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('t1', { progressNote: GREETING_NOT_RECORDED_NOTE });
    expect((await readOnboardingState(t.configStore))?.greetingNudgedAt).toBe(due.toISOString());
  });

  it('skips the idle nudge while the next session is booked', async () => {
    const replied = new Date(START.getTime() + 3_600_000);
    const quiet = new Date(replied.getTime() + 5 * 3_600_000);
    const booked = setup({ open: true, openTopic: true, booked: true, state: { lastPrincipalTurnAt: replied.toISOString() } });
    await booked.seed();
    await booked.watcher.tick(quiet);
    expect(booked.enqueueTaskWake).not.toHaveBeenCalled();

    const idle = setup({ open: true, openTopic: true, booked: false, state: { lastPrincipalTurnAt: replied.toISOString() } });
    await idle.seed();
    await idle.watcher.tick(quiet);
    expect(idle.enqueueTaskWake).toHaveBeenCalledTimes(1);
  });

  describe('invitation staleness', () => {
    const expired = (id: string) => ({ id, expiresAt: new Date(START.getTime() + 1000), redeemed: false });
    const preGreeting = { greetingSentAt: null };

    it("notifies for this run's expired invitation, known by its id", async () => {
      const t = setup({ open: true, state: preGreeting, invitation: expired('inv-run') });
      await t.seed();
      await t.watcher.tick(later);
      expect((await readOnboardingState(t.configStore))?.operatorNotified).toContain('invitation_expired');
    });

    it('ignores an unused invitation that is not the one this run minted', async () => {
      const t = setup({ open: true, state: preGreeting, invitation: expired('inv-other') });
      await t.seed();
      await t.watcher.tick(later);
      expect((await readOnboardingState(t.configStore))?.operatorNotified).toEqual([]);
    });

    it('a replacement link redeemed during the run dates the greeting', async () => {
      const redeemedAt = new Date(START.getTime() + 3_600_000);
      const t = setup({
        open: true,
        state: preGreeting,
        invitation: { id: 'inv-replacement', expiresAt: new Date(START.getTime() + 48 * 3_600_000), redeemed: true, redeemedAt },
      });
      await t.seed();
      await t.watcher.tick(new Date(redeemedAt.getTime() + GREETING_FOLLOWUP_GAP_HOURS * 3_600_000));
      expect(t.taskRepo.updateTask).toHaveBeenCalledWith('t1', { progressNote: GREETING_NOT_RECORDED_NOTE });
    });

    it('ignores the invitation off the app route', async () => {
      const t = setup({ open: true, state: { ...preGreeting, route: 'signal' }, invitation: expired('inv-run') });
      await t.seed();
      await t.watcher.tick(later);
      expect(t.readInvitation).not.toHaveBeenCalled();
      expect((await readOnboardingState(t.configStore))?.operatorNotified).toEqual([]);
    });
  });
});

describe('isNextSessionBooked', () => {
  const now = new Date('2026-11-21T10:00:00Z');
  const pool = (booked: boolean) => ({ query: vi.fn(async () => ({ rows: [{ booked }] })) });

  it('is booked by a pending wake of the task set for later', async () => {
    const p = pool(true);
    expect(await isNextSessionBooked({ pool: p, listPendingAgendas: async () => [] }, 't1', now)).toBe(true);
    expect((p.query.mock.calls[0] as unknown[])[1]).toEqual(['t1', now]);
  });

  it('counts the wake_at a booking sets with task-update, including one deferred while its own wake runs', async () => {
    const p = pool(true);
    await isNextSessionBooked({ pool: p, listPendingAgendas: async () => [] }, 't1', now);
    const sql = (p.query.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("status = 'running' AND deferred_wake_at > $2");
    // A booked wake running early (runTaskWakeEarly) keeps its booked time on deferred_wake_at.
    expect(sql).toContain('GREATEST(COALESCE(next_run_at, run_at), deferred_wake_at) > $2');
  });

  it('is booked by a pending agenda the task owns, and not by another task\'s', async () => {
    expect(await isNextSessionBooked({ pool: pool(false), listPendingAgendas: async () => [{ ownerTaskId: 't1' }] }, 't1', now)).toBe(true);
    expect(await isNextSessionBooked({ pool: pool(false), listPendingAgendas: async () => [{ ownerTaskId: 'other' }, { ownerTaskId: null }] }, 't1', now)).toBe(false);
  });
});
