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
const logger = Object.assign(pino({ level: 'silent' }), { warn }) as unknown as ReturnType<typeof pino>;

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

async function setup(opts: { open: boolean; state?: Partial<OnboardingState> }) {
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
  const scheduler = { enqueueTaskWake: vi.fn(async (_p: { taskId: string; agentId: string }) => ({ jobId: 'j1' })) };
  new OnboardingSubscribers({
    bus: bus as never,
    taskRepo: taskRepo as never,
    scheduler,
    configStore,
    logger,
    googleClientId: async () => 'client-123',
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

  it('a blocked sign-in notifies the operator once, with the client id', async () => {
    warn.mockClear();
    const t = await setup({ open: true });
    await t.fire(blocked());
    await t.fire(blocked());
    expect(t.taskRepo.updateTask).toHaveBeenCalledTimes(1);
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('t1', { progressNote: 'Operator notice: mailbox_signin_blocked' });
    expect(t.scheduler.enqueueTaskWake).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mailbox_signin_blocked', details: { outcome: 'admin_blocked', clientId: 'client-123' } }),
      'onboarding: operator notice',
    );
    const saved = JSON.parse(t.data.get('onboarding/state')!) as OnboardingState;
    expect(saved.operatorNotified).toContain('mailbox_signin_blocked');
  });

  it("a blocked sign-in for Curia's own mailbox is ignored", async () => {
    const t = await setup({ open: true });
    await t.fire(createMailboxSignInFinished({ target: 'curia', outcome: 'admin_blocked' }));
    expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
  });

  it('keeps a state change made while the client id was being read', async () => {
    const t = await setup({ open: true });
    await t.fire(blocked());
    const saved = JSON.parse(t.data.get('onboarding/state')!) as OnboardingState;
    expect(saved.greetingSentAt).toBeNull();
    t.data.set('onboarding/state', JSON.stringify({ ...saved, operatorNotified: [], greetingSentAt: 'x' }));
    await t.fire(blocked());
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
