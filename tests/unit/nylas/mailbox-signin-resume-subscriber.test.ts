// mailbox-signin-resume-subscriber.test.ts — resuming the agent that sent a mailbox sign-in link
// (#2361). A fake bus records subscriptions and publishes and lets a test emit events.

import { describe, it, expect, vi } from 'vitest';
import { createSilentLogger } from '../../../src/logger.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { AgentTaskEvent, BusEvent, EventType, Layer } from '../../../src/bus/events.js';
import { createMailboxSignInFinished } from '../../../src/bus/events.js';
import { encodeResumeToken } from '../../../src/agents/resume-token.js';
import {
  MailboxSignInResumeSubscriber,
  mailboxSignInResumeLine,
  type MailboxSignInResumeSubscriberDeps,
} from '../../../src/nylas/mailbox-signin-resume-subscriber.js';
import { MAILBOX_SIGNIN_OUTCOMES } from '../../../src/nylas/signin-outcome.js';

const ORIGINATOR = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't', tier: 'principal' };

function makeFakeBus() {
  const handlers = new Map<EventType, Array<(e: BusEvent) => unknown>>();
  const published: Array<{ layer: Layer; event: BusEvent }> = [];
  const bus = {
    subscribe(type: EventType, _layer: Layer, handler: (e: BusEvent) => unknown) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    async publish(layer: Layer, event: BusEvent) {
      published.push({ layer, event });
    },
  } as unknown as EventBus;
  const emit = async (event: BusEvent) => {
    for (const h of handlers.get(event.type) ?? []) await h(event);
  };
  return { bus, published, emit };
}

function finished(over: Partial<Parameters<typeof createMailboxSignInFinished>[0]> = {}) {
  return createMailboxSignInFinished({
    target: 'principal',
    outcome: 'connected',
    mailboxId: 'example',
    conversationId: 'conv-1',
    channelId: 'email',
    agentId: 'coordinator',
    taskEventId: 'task-evt-1',
    originator: ORIGINATOR,
    ...over,
  }, 'task-evt-1');
}

function setup(over: Partial<MailboxSignInResumeSubscriberDeps> = {}) {
  const { bus, published, emit } = makeFakeBus();
  const registerRouting = vi.fn();
  const sendNotification = vi.fn(async () => true);
  const googleClientId = vi.fn(async () => '1234-abc.apps.googleusercontent.com' as string | undefined);
  const sub = new MailboxSignInResumeSubscriber({
    bus,
    logger: createSilentLogger(),
    registerRouting,
    googleClientId,
    notifier: { gateway: { sendNotification }, principalEmail: () => 'boss@example.com' },
    ...over,
  });
  sub.start();
  const tasks = () => published.filter((p) => p.event.type === 'agent.task').map((p) => p.event as AgentTaskEvent);
  return { emit, published, tasks, registerRouting, sendNotification, googleClientId };
}

describe('mailboxSignInResumeLine', () => {
  it('says "connected — continue" on success, and a reason plus a fresh-link hint otherwise', () => {
    expect(mailboxSignInResumeLine('connected', 'principal')).toContain('connected — continue');
    expect(mailboxSignInResumeLine('reconnected', 'principal')).toContain('connected — continue');
    for (const outcome of MAILBOX_SIGNIN_OUTCOMES.filter((o) => o !== 'connected' && o !== 'reconnected')) {
      const line = mailboxSignInResumeLine(outcome, 'principal');
      expect(line, outcome).toContain('`mailbox-signin-link`');
      expect(line, outcome).not.toContain('continue');
    }
  });

  it('gives each failure its own reason', () => {
    const lines = MAILBOX_SIGNIN_OUTCOMES.filter((o) => o !== 'connected' && o !== 'reconnected')
      .map((o) => mailboxSignInResumeLine(o, 'principal'));
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('admin_blocked says a notice was requested (not delivered) and names the client id, or the generic phrase', () => {
    const named = mailboxSignInResumeLine('admin_blocked', 'principal', { clientId: '1234-abc.apps.googleusercontent.com', operatorNotified: true });
    expect(named).toContain('1234-abc.apps.googleusercontent.com');
    expect(named).toContain('Curia asked for a notice to be sent to the operator');
    // A published notice is not a delivered email: never claimed as one.
    expect(named).not.toMatch(/operator has been (told|notified)/);
    expect(named).toMatch(/an administrator must mark .* as Trusted/);
    expect(mailboxSignInResumeLine('admin_blocked', 'principal', { operatorNotified: true })).toContain('the OAuth client ID from your Google Cloud project');
  });

  it('admin_blocked says the operator could not be told when the notice did not go (I)', () => {
    const line = mailboxSignInResumeLine('admin_blocked', 'principal', { operatorNotified: false });
    expect(line).not.toMatch(/operator has been/);
    expect(line).toContain("I couldn't notify the operator; ask them to mark the app Trusted in the Google Workspace admin console");
  });

  it('account_limit names the 5-account sandbox limit and what frees one', () => {
    const line = mailboxSignInResumeLine('account_limit', 'principal');
    expect(line).toContain("Nylas's account limit is reached");
    expect(line).toContain('5 connected accounts');
    expect(line).toMatch(/remove an unused mailbox, or move to a production Nylas application/);
    expect(line).toMatch(/fresh link once an account is freed\.$/);
  });

  it("names Curia's own mailbox for the curia target, and the restart only when one is scheduled (J)", () => {
    const restarting = mailboxSignInResumeLine('connected', 'curia', { restartScheduled: true });
    expect(restarting).toContain("Curia's own mailbox");
    expect(restarting).toMatch(/restart/i);
    expect(mailboxSignInResumeLine('reconnected', 'curia')).not.toMatch(/restart/i);
  });
});

describe('MailboxSignInResumeSubscriber', () => {
  it('re-enters the originating agent with a synthetic task, routed back to its channel', async () => {
    const { emit, tasks, registerRouting } = setup();
    await emit(finished());
    expect(tasks()).toHaveLength(1);
    const t = tasks()[0]!;
    expect(t.payload).toMatchObject({ agentId: 'coordinator', conversationId: 'conv-1', channelId: 'email', senderId: 'ceo', syntheticTurn: true });
    expect(t.payload.content).toContain('connected — continue');
    expect(t.parentEventId).toBe('task-evt-1');
    expect(registerRouting).toHaveBeenCalledWith(t.id, expect.objectContaining({ channelId: 'email', conversationId: 'conv-1', senderId: 'ceo' }));
  });

  it('does not resume when a restart is scheduled (R6): the turn would be cut by the exit', async () => {
    const { emit, tasks, registerRouting } = setup();
    await emit(finished({ target: 'curia', outcome: 'connected', mailboxId: undefined, restartScheduled: true }));
    expect(tasks()).toHaveLength(0);
    expect(registerRouting).not.toHaveBeenCalled();
  });

  it('a Curia re-auth with no restart resumes without promising one (J)', async () => {
    const { emit, tasks } = setup();
    await emit(finished({ target: 'curia', outcome: 'reconnected', mailboxId: undefined }));
    expect(tasks()[0]!.payload.content).toContain("Curia's own mailbox is connected");
    expect(tasks()[0]!.payload.content).not.toMatch(/restart/i);
  });

  it('handles one event id once', async () => {
    const { emit, tasks } = setup();
    const e = finished();
    await emit(e);
    await emit(e);
    expect(tasks()).toHaveLength(1);
  });

  it('does not resume a sign-in with no routable origin (started from the console)', async () => {
    const { emit, tasks } = setup();
    await emit(createMailboxSignInFinished({ target: 'principal', outcome: 'connected', mailboxId: 'example' }));
    expect(tasks()).toHaveLength(0);
  });

  it('does not resume onto an internal channel', async () => {
    const { emit, tasks } = setup();
    await emit(finished({ channelId: 'internal' }));
    expect(tasks()).toHaveLength(0);
  });

  it('asks the coordinator to re-delegate with the resume_token of a delegated specialist', async () => {
    const { emit, tasks } = setup();
    const resumeToken = encodeResumeToken({ agent: 'setup-wizard', originalTask: 'connect the mailbox', context: 'waiting for sign-in' });
    await emit(finished({ resumeToken, outcome: 'expired' }));
    const content = tasks()[0]!.payload.content;
    expect(content).toContain(resumeToken);
    expect(content).toContain("'setup-wizard'");
    expect(content).toContain('`mailbox-signin-link`');
  });

  it('admin_blocked: notifies the operator with the client id and tells the agent', async () => {
    const { emit, tasks, sendNotification } = setup();
    await emit(finished({ outcome: 'admin_blocked', mailboxId: undefined }));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const notice = (sendNotification.mock.calls[0] as unknown as [{ notificationType: string; ceoEmail: string; subject: string; body: string }])[0];
    expect(notice).toMatchObject({ notificationType: 'mailbox_signin_admin_blocked', ceoEmail: 'boss@example.com' });
    expect(notice.body).toContain('1234-abc.apps.googleusercontent.com');
    expect(tasks()[0]!.payload.content).toContain('1234-abc.apps.googleusercontent.com');
  });

  it('admin_blocked from the console (no origin) still notifies the operator', async () => {
    const { emit, tasks, sendNotification } = setup();
    await emit(createMailboxSignInFinished({ target: 'curia', outcome: 'admin_blocked' }));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(tasks()).toHaveLength(0);
  });

  it('admin_blocked with no client id known uses the generic phrase in both messages', async () => {
    const { emit, tasks, sendNotification } = setup({ googleClientId: async () => { throw new Error('nylas down'); } });
    await emit(finished({ outcome: 'admin_blocked' }));
    const notice = (sendNotification.mock.calls[0] as unknown as [{ body: string }])[0];
    expect(notice.body).toContain('the OAuth client ID from your Google Cloud project');
    expect(tasks()[0]!.payload.content).toContain('the OAuth client ID from your Google Cloud project');
  });

  it('admin_blocked: when the notice is not delivered, the agent is told the operator was not notified (I)', async () => {
    const { emit, tasks } = setup({ notifier: { gateway: { sendNotification: vi.fn(async () => false) }, principalEmail: () => 'boss@example.com' } });
    await emit(finished({ outcome: 'admin_blocked' }));
    const content = tasks()[0]!.payload.content;
    expect(content).not.toMatch(/operator has been/);
    expect(content).toContain("I couldn't notify the operator");
  });

  it('admin_blocked: no email adapter delivers yet, so nothing is sent and the agent is told so (I)', async () => {
    const sendNotification = vi.fn(async () => true);
    const { emit, tasks } = setup({ notifier: { gateway: { sendNotification }, principalEmail: () => 'boss@example.com', canDeliver: () => false } });
    await emit(finished({ outcome: 'admin_blocked' }));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(tasks()[0]!.payload.content).toContain("I couldn't notify the operator");
  });

  it('admin_blocked: a published notice is reported as requested, with the administrator step', async () => {
    const { emit, tasks } = setup();
    await emit(finished({ outcome: 'admin_blocked' }));
    expect(tasks()[0]!.payload.content).toContain('Curia asked for a notice to be sent to the operator');
    expect(tasks()[0]!.payload.content).toMatch(/as Trusted in the Google Admin console/);
  });

  it('other outcomes send no operator notice', async () => {
    const { emit, sendNotification, googleClientId } = setup();
    await emit(finished({ outcome: 'wrong_account' }));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(googleClientId).not.toHaveBeenCalled();
  });
});
