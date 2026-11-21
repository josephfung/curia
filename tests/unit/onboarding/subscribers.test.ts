import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { OnboardingSubscribers } from '../../../src/onboarding/subscribers.js';
import { writeOnboardingState, type OnboardingState } from '../../../src/onboarding/state.js';
import { ONBOARDING_CREATED_BY } from '../../../src/onboarding/constants.js';
import {
  createMailboxSignInFinished,
  createPairingInvitationRedeemed,
  createPrincipalMailboxConnected,
  type BusEvent,
} from '../../../src/bus/events.js';

const warn = vi.fn();
const logger = Object.assign(pino({ level: 'silent' }), { warn });

const baseState: OnboardingState = {
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

async function setup(opts: { open: boolean; state?: Partial<OnboardingState>; googleClientId?: () => Promise<string | undefined> }) {
  const handlers = new Map<string, (e: BusEvent) => unknown>();
  const bus = { subscribe: (type: string, _layer: string, h: (e: BusEvent) => unknown) => void handlers.set(type, h) };
  const data = new Map<string, string>();
  const configStore = {
    get: async (ns: string, k: string) => data.get(`${ns}/${k}`) ?? null,
    set: async (ns: string, k: string, v: string) => {
      data.set(`${ns}/${k}`, v);
      return { stored: true, action: 'created' };
    },
  };
  await writeOnboardingState(configStore, { ...baseState, ...opts.state });
  const taskRepo = {
    listTasks: vi.fn(async () => (opts.open ? [{ id: 't1', parentTaskId: null, createdBy: ONBOARDING_CREATED_BY }] : [])),
    updateTask: vi.fn(async () => ({})),
  };
  const scheduler = {
    enqueueTaskWake: vi.fn(async (_p: { taskId: string; agentId: string }) => ({ jobId: 'j1' })),
    runTaskWakeEarly: vi.fn(async (_id: string, _at: Date) => false),
  };
  new OnboardingSubscribers({
    bus: bus as never,
    taskRepo: taskRepo as never,
    scheduler,
    configStore,
    stateLock: (fn) => fn(),
    logger: logger as never,
    googleClientId: opts.googleClientId ?? (async () => 'client-123'),
  }).start();
  const fire = async (e: BusEvent) => { await handlers.get(e.type)?.(e); };
  return { fire, taskRepo, scheduler, data };
}

const redeemed = () => createPairingInvitationRedeemed({ invitationId: 'inv1', deviceName: 'Pixel' });
const connected = () => createPrincipalMailboxConnected({ mailboxId: 'personal' });
const blocked = () => createMailboxSignInFinished({ target: 'principal', outcome: 'admin_blocked' });

describe('OnboardingSubscribers', () => {
  it.each([['redeemed', redeemed], ['connected', connected], ['blocked', blocked]])(
    '%s with no open onboarding task does nothing',
    async (_n, make) => {
      const t = await setup({ open: false });
      await t.fire(make());
      expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
      expect(t.scheduler.enqueueTaskWake).not.toHaveBeenCalled();
    },
  );

  it('invitation redeemed notes the task and wakes it once', async () => {
    const t = await setup({ open: true });
    await t.fire(redeemed());
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('t1', { progressNote: 'Phone app paired: send the greeting in the app' });
    expect(t.scheduler.enqueueTaskWake).toHaveBeenCalledTimes(1);
    expect(t.scheduler.enqueueTaskWake.mock.calls[0]![0]).toMatchObject({ taskId: 't1', agentId: 'coordinator' });
  });

  it('invitation redeemed after the greeting was sent does nothing', async () => {
    const t = await setup({ open: true, state: { greetingSentAt: '2026-11-20T11:00:00.000Z' } });
    await t.fire(redeemed());
    expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
    expect(t.scheduler.enqueueTaskWake).not.toHaveBeenCalled();
  });

  it.each([
    ['a Signal-route run', { route: 'signal' as const }],
    ['a principal start with no route', { route: null }],
    ['state from another run', { taskId: 'old-run' }],
  ])('invitation redeemed during %s adds no app greeting note', async (_n, state) => {
    const t = await setup({ open: true, state });
    await t.fire(redeemed());
    expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
    expect(t.scheduler.enqueueTaskWake).not.toHaveBeenCalled();
  });

  it('a foreign link redeemed before Start, delivered late, adds no note', async () => {
    const t = await setup({ open: true, state: { invitationId: 'run-link' } });
    const late = { ...redeemed(), timestamp: new Date('2026-11-20T09:59:59.000Z') };
    await t.fire(late);
    expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
    expect(t.scheduler.enqueueTaskWake).not.toHaveBeenCalled();
  });

  it("the run's own link counts whenever its event is dated", async () => {
    const t = await setup({ open: true, state: { invitationId: 'inv1' } });
    await t.fire({ ...redeemed(), timestamp: new Date('2026-11-20T09:59:59.000Z') });
    expect(t.taskRepo.updateTask).toHaveBeenCalledTimes(1);
  });

  it('mailbox connected notes the task and wakes it once', async () => {
    const t = await setup({ open: true });
    await t.fire(connected());
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('t1', {
      progressNote: 'Mailbox connected (personal): run the first look; pick up connect-mailbox / inbox-expectations',
    });
    expect(t.scheduler.enqueueTaskWake).toHaveBeenCalledTimes(1);
  });

  it('a duplicate-wake error is tolerated', async () => {
    const t = await setup({ open: true });
    t.scheduler.enqueueTaskWake.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(t.fire(connected())).resolves.toBeUndefined();
  });

  // The next session is booked for later: the mailbox's first look must not wait for it.
  it('mailbox connected while a later session is booked runs that wake now, keeping the booking', async () => {
    const t = await setup({ open: true });
    t.scheduler.enqueueTaskWake.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    t.scheduler.runTaskWakeEarly.mockResolvedValueOnce(true);
    await t.fire(connected());
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({ progressNote: expect.stringContaining('Mailbox connected') }));
    expect(t.scheduler.runTaskWakeEarly).toHaveBeenCalledWith('t1', expect.any(Date));
  });

  it('a blocked sign-in notifies the operator once, logging detail keys but not values', async () => {
    warn.mockClear();
    const t = await setup({ open: true });
    await t.fire(blocked());
    await t.fire(blocked());
    expect(t.taskRepo.updateTask).toHaveBeenCalledTimes(1);
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('t1', { progressNote: 'Operator notice: mailbox_signin_blocked' });
    expect(t.scheduler.enqueueTaskWake).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mailbox_signin_blocked', detailKeys: ['outcome', 'clientId'] }),
      'onboarding: operator notice',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('client-123');
    const saved = JSON.parse(t.data.get('onboarding/state')!) as OnboardingState;
    expect(saved.operatorNotified).toContain('mailbox_signin_blocked');
  });

  it("a blocked sign-in for Curia's own mailbox is ignored", async () => {
    const t = await setup({ open: true });
    await t.fire(createMailboxSignInFinished({ target: 'curia', outcome: 'admin_blocked' }));
    expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
  });

  it('keeps a state change made while the client id was being read', async () => {
    let lookupStarted!: () => void;
    const started = new Promise<void>((r) => { lookupStarted = r; });
    let resolveClientId!: (id: string) => void;
    const clientId = new Promise<string>((r) => { resolveClientId = r; });
    const t = await setup({
      open: true,
      googleClientId: () => {
        lookupStarted();
        return clientId;
      },
    });
    const firing = t.fire(blocked());
    await started;
    // The greeting is recorded while the handler waits on the lookup.
    const before = JSON.parse(t.data.get('onboarding/state')!) as OnboardingState;
    t.data.set('onboarding/state', JSON.stringify({ ...before, greetingSentAt: 'x' }));
    resolveClientId('client-123');
    await firing;
    const after = JSON.parse(t.data.get('onboarding/state')!) as OnboardingState;
    expect(after.greetingSentAt).toBe('x');
    expect(after.operatorNotified).toContain('mailbox_signin_blocked');
  });

  it('a connected sign-in is not a blocked one', async () => {
    const t = await setup({ open: true });
    await t.fire(createMailboxSignInFinished({ target: 'principal', outcome: 'connected' }));
    expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
  });
});
