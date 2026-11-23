// Operator notices during onboarding (#2360, #2710).
//
// The four events used to be recorded on the onboarding task and delivered to nobody. They now
// go through OutboundGateway.sendNotification, like every other system notice, so the gateway
// addresses them from the notification type (all four are operator-routed, ADR-068).
//
// Three rules this file pins:
//   - Every event is emailed, once per onboarding run, and still leaves its progress note.
//   - Nothing model-supplied reaches the email: a tool call's `details` are context for the note,
//     the log and the audit row only.
//   - With no gateway (no outbound path) the note is still recorded — the notice is never lost.
import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../../../src/logger.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { OutboundNotificationRequest } from '../../../src/bus/events.js';
import { notifyOperator, OPERATOR_EVENTS, type OperatorEvent } from '../../../src/onboarding/notify-operator.js';
import { notifyOperatorOnce } from '../../../src/onboarding/notify-operator-once.js';
import { ONBOARDING_NAMESPACE, ONBOARDING_STATE_KEY, type OnboardingState } from '../../../src/onboarding/state.js';

type SendNotification = (request: OutboundNotificationRequest, parentEventId?: string) => Promise<boolean>;

function makeGateway(sent = true) {
  const sendNotification = vi.fn<SendNotification>().mockResolvedValue(sent);
  return { gateway: { sendNotification } as Pick<OutboundGateway, 'sendNotification'>, sendNotification };
}

function makeDeps(overrides: {
  gateway?: Pick<OutboundGateway, 'sendNotification'>;
  audit?: (e: Record<string, unknown>) => void;
} = {}) {
  const updateTask = vi.fn().mockResolvedValue(null);
  const logger = createLogger('error');
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  return {
    deps: {
      taskRepo: { updateTask },
      logger,
      appOrigin: 'https://curia.example.com',
      ...(overrides.gateway ? { gateway: overrides.gateway } : {}),
      ...(overrides.audit ? { audit: overrides.audit } : {}),
    },
    updateTask,
    warn,
    error,
  };
}

describe('notifyOperator delivery', () => {
  it('says the greeting was never recorded, not that it went unanswered, when none was sent (#2710 review)', async () => {
    const { gateway, sendNotification } = makeGateway();
    const { deps } = makeDeps({ gateway });
    await notifyOperator(deps, 'task-1', 'greeting_unanswered', { greetingNotRecorded: true });
    const request = sendNotification.mock.calls[0]![0];
    expect(request.subject).toContain('never recorded');
    expect(request.body).not.toContain('went unanswered');
    expect(request.body).not.toContain('Nothing is broken');
    expect(request.body).toContain('console');

    // The answered-nothing case keeps its own text.
    const plain = makeGateway();
    await notifyOperator(makeDeps({ gateway: plain.gateway }).deps, 'task-1', 'greeting_unanswered');
    expect(plain.sendNotification.mock.calls[0]![0].body).toContain('went unanswered');
  });

  it('emails every operator event through sendNotification, keeping the progress note', async () => {
    for (const event of OPERATOR_EVENTS) {
      const { gateway, sendNotification } = makeGateway();
      const { deps, updateTask } = makeDeps({ gateway });

      await expect(notifyOperator(deps, 'task-1', event)).resolves.toEqual({ recorded: true, emailed: true });

      expect(updateTask, event).toHaveBeenCalledWith('task-1', { progressNote: `Operator notice: ${event}` });
      expect(sendNotification, event).toHaveBeenCalledOnce();
      const request = sendNotification.mock.calls[0]![0] as {
        notificationType: OperatorEvent; subject: string; body: string; recipient?: string;
      };
      // The type is the audience input: the gateway resolves who from NOTIFICATION_AUDIENCES.
      expect(request.notificationType, event).toBe(event);
      expect(request, event).not.toHaveProperty('recipient');
      expect(request, event).not.toHaveProperty('ceoEmail');
      expect(request.subject.length, event).toBeGreaterThan(0);
      expect(request.body, event).toContain('https://curia.example.com/');
      // Nothing in any body names an address. No principal content, no model text.
      expect(request.body, event).not.toMatch(/@/);
    }
  });

  it('names the client id to trust for a blocked sign-in, and nothing else from the details bag', async () => {
    const { gateway, sendNotification } = makeGateway();
    const { deps } = makeDeps({ gateway });

    await notifyOperator(deps, 'task-1', 'mailbox_signin_blocked', {
      clientId: '1234-abc.apps.googleusercontent.com',
      details: { outcome: 'admin_blocked', quote: 'a model-written sentence about the principal' },
    });

    const body = sendNotification.mock.calls[0]![0].body as string;
    expect(body).toContain('1234-abc.apps.googleusercontent.com');
    // The model-supplied detail value is context for the note and log, never the email.
    expect(body).not.toContain('a model-written sentence about the principal');
    expect(body).not.toContain('admin_blocked');
  });

  it('keeps the audit row, with the detail keys and no values', async () => {
    const audit = vi.fn();
    const { gateway } = makeGateway();
    const { deps } = makeDeps({ gateway, audit });

    await notifyOperator(deps, 'task-1', 'web_search_failed', { details: { query: 'secret model text' } });

    expect(audit).toHaveBeenCalledWith({
      type: 'onboarding.operator_notice',
      taskId: 'task-1',
      event: 'web_search_failed',
      detailKeys: ['query'],
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret model text');
  });

  it('records the note and reports success when there is no outbound path', async () => {
    const { deps, updateTask } = makeDeps();
    await expect(notifyOperator(deps, 'task-1', 'invitation_expired'))
      .resolves.toEqual({ recorded: true, emailed: false });
    expect(updateTask).toHaveBeenCalledOnce();
  });

  it('logs at error level when the email could not be published, and still reports the notice recorded', async () => {
    const { gateway } = makeGateway(false);
    const { deps, error } = makeDeps({ gateway });
    await expect(notifyOperator(deps, 'task-1', 'greeting_unanswered'))
      .resolves.toEqual({ recorded: true, emailed: false });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', event: 'greeting_unanswered' }),
      expect.stringContaining('could not be sent'),
    );
  });
});

// ---------------------------------------------------------------------------
// Once per onboarding run
// ---------------------------------------------------------------------------

function stateStore(initial: OnboardingState) {
  const data = new Map<string, string>([[`${ONBOARDING_NAMESPACE}/${ONBOARDING_STATE_KEY}`, JSON.stringify(initial)]]);
  return {
    data,
    store: {
      get: vi.fn(async (ns: string, key: string) => data.get(`${ns}/${key}`) ?? null),
      set: vi.fn(async (ns: string, key: string, value: string) => {
        data.set(`${ns}/${key}`, value);
        // writeOnboardingStateRaw treats a rejected write as a failure and throws.
        return { stored: true, action: 'created' };
      }),
    },
  };
}

const RUN: OnboardingState = {
  taskId: 'task-1',
  startedAt: '2026-11-01T00:00:00.000Z',
  route: 'app',
  greetingSentAt: null,
  followUpsSent: 3,
  lastFollowUpAt: null,
  lastPrincipalTurnAt: null,
  idleNudgeSentAt: null,
  operatorNotified: [],
};

describe('notifyOperatorOnce delivery', () => {
  it('sends one email per event per run, and records that it did', async () => {
    const { gateway, sendNotification } = makeGateway();
    const { deps } = makeDeps({ gateway });
    const { store, data } = stateStore(RUN);
    const once = { ...deps, configStore: store, stateLock: <T>(fn: () => Promise<T>) => fn() };

    await expect(notifyOperatorOnce(once, 'task-1', 'invitation_expired')).resolves.toBe(true);
    // The second time the run-state already lists the event, so nothing is sent or noted again.
    await expect(notifyOperatorOnce(once, 'task-1', 'invitation_expired')).resolves.toBe(false);

    expect(sendNotification).toHaveBeenCalledOnce();
    expect(deps.taskRepo.updateTask).toHaveBeenCalledOnce();
    const saved = JSON.parse(data.get(`${ONBOARDING_NAMESPACE}/${ONBOARDING_STATE_KEY}`)!) as OnboardingState;
    expect(saved.operatorNotified).toContain('invitation_expired');
  });

  it('sends nothing for a run that is not this task', async () => {
    const { gateway, sendNotification } = makeGateway();
    const { deps } = makeDeps({ gateway });
    const { store } = stateStore({ ...RUN, taskId: 'other-task' });
    const once = { ...deps, configStore: store, stateLock: <T>(fn: () => Promise<T>) => fn() };

    await expect(notifyOperatorOnce(once, 'task-1', 'greeting_unanswered')).resolves.toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('records a failed email separately from the raised notice (#2710)', async () => {
    const { gateway } = makeGateway(false);
    const { deps } = makeDeps({ gateway });
    const { store, data } = stateStore(RUN);
    const once = { ...deps, configStore: store, stateLock: <T>(fn: () => Promise<T>) => fn() };

    // The notice is raised (so the once-per-run guard holds) and the state says the email failed:
    // "raised" must never read as "the operator heard it".
    await expect(notifyOperatorOnce(once, 'task-1', 'web_search_failed')).resolves.toBe(true);
    let saved = JSON.parse(data.get(`${ONBOARDING_NAMESPACE}/${ONBOARDING_STATE_KEY}`)!) as OnboardingState;
    expect(saved.operatorNotified).toContain('web_search_failed');
    expect(saved.operatorNoticeFailed).toEqual(['web_search_failed']);

    // A notice that is delivered records no failure, so the field means what it says.
    const delivered = makeGateway(true);
    const fresh = stateStore(RUN);
    const second = {
      ...makeDeps({ gateway: delivered.gateway }).deps,
      configStore: fresh.store,
      stateLock: <T>(fn: () => Promise<T>) => fn(),
    };
    await expect(notifyOperatorOnce(second, 'task-1', 'web_search_failed')).resolves.toBe(true);
    const deliveredState = JSON.parse(fresh.data.get(`${ONBOARDING_NAMESPACE}/${ONBOARDING_STATE_KEY}`)!) as OnboardingState;
    expect(deliveredState.operatorNoticeFailed ?? []).toEqual([]);
  });

  it('gives the event back when the task note could not be written, so a retry raises it (#2710 review)', async () => {
    const { gateway, sendNotification } = makeGateway();
    const { deps, updateTask } = makeDeps({ gateway });
    updateTask.mockRejectedValueOnce(new Error('db down'));
    const { store, data } = stateStore(RUN);
    const once = { ...deps, configStore: store, stateLock: <T>(fn: () => Promise<T>) => fn() };

    await expect(notifyOperatorOnce(once, 'task-1', 'web_search_failed')).resolves.toBe(false);
    let saved = JSON.parse(data.get(`${ONBOARDING_NAMESPACE}/${ONBOARDING_STATE_KEY}`)!) as OnboardingState;
    expect(saved.operatorNotified).not.toContain('web_search_failed');
    expect(sendNotification).not.toHaveBeenCalled();

    // The retry the tool asks for now records and sends it.
    await expect(notifyOperatorOnce(once, 'task-1', 'web_search_failed')).resolves.toBe(true);
    saved = JSON.parse(data.get(`${ONBOARDING_NAMESPACE}/${ONBOARDING_STATE_KEY}`)!) as OnboardingState;
    expect(saved.operatorNotified).toEqual(['web_search_failed']);
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it('delegates to an injected notifier, which is how the tool path reaches the gateway', async () => {
    const notifier = vi.fn().mockResolvedValue({ recorded: true, emailed: true });
    const { deps } = makeDeps();
    const { store } = stateStore(RUN);
    const once = { ...deps, configStore: store, stateLock: <T>(fn: () => Promise<T>) => fn(), notifier };

    await expect(notifyOperatorOnce(once, 'task-1', 'web_search_failed', { details: { q: 'x' } })).resolves.toBe(true);
    expect(notifier).toHaveBeenCalledWith('task-1', 'web_search_failed', { details: { q: 'x' } });
  });
});
