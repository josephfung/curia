import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import { onboardingRoutes, type OnboardingRouteOptions } from '../../../../src/channels/http/routes/onboarding.js';
import { hashToken, type SessionStore } from '../../../../src/channels/http/session-auth.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { StartResult } from '../../../../src/onboarding/onboarding-service.js';

const SECRET = 'test-bootstrap-secret';
const OPERATOR_COOKIE = 'operator-session-cookie-value';
const OPERATOR_SESSION_ID = '44444444-4444-4444-8444-444444444444';

const STARTED: StartResult = {
  ok: true,
  taskId: 'task-1',
  invitation: { id: 'inv-1', url: 'https://curia.example.com/pair#c=tok', expiresAt: '2026-11-22T12:00:00.000Z' },
  restartScheduled: false,
};

async function appWith(opts: { publish?: () => Promise<void> } = {}) {
  const sessions: SessionStore = new Map();
  sessions.set(hashToken(OPERATOR_COOKIE), {
    id: OPERATOR_SESSION_ID,
    expiresAt: Date.now() + 60 * 60 * 1000,
    renewedAt: Date.now(),
  });
  const onboarding = {
    status: vi.fn(),
    start: vi.fn(async () => STARTED),
    releaseTriageHold: vi.fn(async () => {}),
    stopInvitation: vi.fn(async () => true),
  };
  const publish = vi.fn(opts.publish ?? (async () => {}));
  const app = Fastify();
  await app.register(cookie);
  await app.register(onboardingRoutes, {
    webAppBootstrapSecret: SECRET,
    sessions,
    bus: { publish } as unknown as EventBus,
    logger: createSilentLogger(),
    onboarding: onboarding as unknown as OnboardingRouteOptions['onboarding'],
  });
  return { app, onboarding, publish };
}

const SESSION_HEADERS = { cookie: `curia_session=${OPERATOR_COOKIE}` };

describe('POST /api/onboarding/start', () => {
  it('refuses the access-key header without a console session (401) and starts nothing', async () => {
    const { app, onboarding } = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/start',
      headers: { 'x-web-bootstrap-secret': SECRET },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(onboarding.start).not.toHaveBeenCalled();
    await app.close();
  });

  it('starts from a signed-in session and audits the invitation with that session', async () => {
    const { app, onboarding, publish } = await appWith();
    const res = await app.inject({ method: 'POST', url: '/api/onboarding/start', headers: SESSION_HEADERS, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(onboarding.start).toHaveBeenCalledWith({ actor: 'operator', confirmWorkingPrincipal: false });
    const events = publish.mock.calls.map((c) => (c as unknown[])[1] as { type: string; payload: Record<string, unknown> });
    expect(events.find((e) => e.type === 'operator.session')?.payload).toMatchObject({
      action: 'invite', initiatedBy: 'session', actorSessionId: OPERATOR_SESSION_ID,
    });
    expect(events.find((e) => e.type === 'config.change')?.payload).toMatchObject({
      config_type: 'onboarding', note: `console session ${OPERATOR_SESSION_ID}`,
    });
    await app.close();
  });

  it('records a start on a messaging route, where no invitation is minted', async () => {
    const { app, onboarding, publish } = await appWith();
    onboarding.start.mockResolvedValue({ ...STARTED, invitation: null } as never);
    const res = await app.inject({ method: 'POST', url: '/api/onboarding/start', headers: SESSION_HEADERS, payload: {} });
    expect(res.statusCode).toBe(200);
    const types = publish.mock.calls.map((c) => ((c as unknown[])[1] as { type: string }).type);
    expect(types).toEqual(['config.change']);
    await app.close();
  });

  it('stops the invitation and answers 500 started_invitation_unaudited when its audit fails', async () => {
    const { app, onboarding } = await appWith({ publish: async () => { throw new Error('bus down'); } });
    onboarding.start.mockResolvedValue({ ...STARTED, restartScheduled: true } as never);
    const res = await app.inject({ method: 'POST', url: '/api/onboarding/start', headers: SESSION_HEADERS, payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'started_invitation_unaudited', taskId: 'task-1', restartScheduled: true });
    expect(onboarding.stopInvitation).toHaveBeenCalledWith('inv-1');
    await app.close();
  });
});

describe('DELETE /api/onboarding/triage-hold', () => {
  it('records the release, naming the session, before lifting the hold', async () => {
    const { app, onboarding, publish } = await appWith();
    const res = await app.inject({ method: 'DELETE', url: '/api/onboarding/triage-hold', headers: SESSION_HEADERS });
    expect(res.statusCode).toBe(200);
    const event = (publish.mock.calls[0] as unknown[])[1] as { type: string; payload: Record<string, unknown> };
    expect(event).toMatchObject({ type: 'config.change', payload: { config_type: 'onboarding_triage_hold', note: `console session ${OPERATOR_SESSION_ID}` } });
    expect(onboarding.releaseTriageHold).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('keeps the hold when the release cannot be recorded', async () => {
    const { app, onboarding } = await appWith({ publish: async () => { throw new Error('bus down'); } });
    const res = await app.inject({ method: 'DELETE', url: '/api/onboarding/triage-hold', headers: SESSION_HEADERS });
    expect(res.statusCode).toBe(500);
    expect(onboarding.releaseTriageHold).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /api/onboarding/status', () => {
  it('answers with the service status, including whether Email triage is held', async () => {
    const { app, onboarding } = await appWith();
    onboarding.status.mockResolvedValue({
      started: true, taskId: 'task-1', showDashboardAlert: false, workingPrincipalSignals: [],
      route: 'app', setupFor: 'other', principalName: 'Avery Example', triageHeld: true,
    });
    const res = await app.inject({ method: 'GET', url: '/api/onboarding/status', headers: SESSION_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ started: true, triageHeld: true });
    await app.close();
  });
});
