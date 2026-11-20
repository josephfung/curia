// The Google Workspace sign-in routes (#2683): console auth on status and start, a public
// callback that always lands on the done page and never echoes the state or code.
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { googleWorkspaceSignInRoutes, type GoogleWorkspaceSignInRouteOptions } from '../../../../../src/channels/http/routes/google-workspace-signin.js';
import {
  WorkspaceCheckUnavailableError,
  WorkspaceSignInUnavailableError,
} from '../../../../../src/google/workspace-signin.js';
import { bypassesBearerAuth } from '../../../../../src/channels/http/auth.js';

const BOOTSTRAP = 'test-bootstrap-secret';
const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };
const CALLBACK = 'https://curia.example.com/api/google-workspace/callback';

type Service = GoogleWorkspaceSignInRouteOptions['service'];

function fakeService(over: Partial<Service> = {}): Service {
  return {
    status: vi.fn(async () => ({ state: 'signed_in' as const })),
    start: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', expiresAt: new Date('2026-11-20T15:00:00Z') })),
    handleCallback: vi.fn(async () => ({ outcome: 'signed_in' as const, restartScheduled: true })),
    callbackUrl: () => CALLBACK,
    ...over,
  };
}

describe('google workspace sign-in routes', () => {
  let app: FastifyInstance;

  async function build(service: Service): Promise<FastifyInstance> {
    app = Fastify() as unknown as FastifyInstance;
    await app.register(googleWorkspaceSignInRoutes, {
      service, webAppBootstrapSecret: BOOTSTRAP, sessions: new Map(), logger: pino({ level: 'silent' }),
    });
    return app;
  }

  afterEach(async () => {
    await app?.close();
  });

  it('is bearer-exempt: the routes authenticate themselves', () => {
    expect(bypassesBearerAuth('/api/google-workspace/callback')).toBe(true);
    expect(bypassesBearerAuth('/api/google-workspace/status')).toBe(true);
    expect(bypassesBearerAuth('/api/google-workspaces')).toBe(false);
  });

  it('refuses status and start without the console secret', async () => {
    const service = fakeService();
    await build(service);
    expect((await app.inject({ method: 'GET', url: '/api/google-workspace/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/google-workspace/signin' })).statusCode).toBe(401);
    expect(service.start).not.toHaveBeenCalled();
  });

  it('status: the live check plus the callback URL to add to the OAuth client', async () => {
    await build(fakeService({ status: async () => ({ state: 'token_rejected', detail: 'Sign in again.' }) }));
    const res = await app.inject({ method: 'GET', url: '/api/google-workspace/status', headers: auth });
    expect(res.json()).toEqual({ state: 'token_rejected', detail: 'Sign in again.', callbackUrl: CALLBACK });
  });

  it('status: unknown, with the reason, when Google cannot be asked', async () => {
    await build(fakeService({ status: async () => { throw new WorkspaceCheckUnavailableError('Google did not answer.'); } }));
    const res = await app.inject({ method: 'GET', url: '/api/google-workspace/status', headers: auth });
    expect(res.json()).toMatchObject({ state: 'unknown', detail: 'Google did not answer.' });
  });

  it('signin: answers Google’s URL', async () => {
    await build(fakeService());
    const res = await app.inject({ method: 'POST', url: '/api/google-workspace/signin', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: expect.stringMatching(/^https:\/\/accounts\.google\.com\//) });
  });

  it('signin: 409 with the reason when sign-in cannot start', async () => {
    await build(fakeService({ start: async () => { throw new WorkspaceSignInUnavailableError('not_configured', 'Save the OAuth client ID first.'); } }));
    const res = await app.inject({ method: 'POST', url: '/api/google-workspace/signin', headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Save the OAuth client ID first.', reason: 'not_configured' });
  });

  it('callback: passes only state, code and error, and redirects with the outcome and restart flag', async () => {
    const service = fakeService({ handleCallback: vi.fn(async () => ({ outcome: 'wrong_account' as const, restartScheduled: false })) });
    await build(service);
    const res = await app.inject({ method: 'GET', url: '/api/google-workspace/callback?state=s1&code=c1&scope=x&authuser=0' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/google-workspace/done?result=wrong_account&restart=0');
    expect(service.handleCallback).toHaveBeenCalledWith({ state: 's1', code: 'c1' });
  });

  it('callback: a repeated parameter is dropped, not passed as an array', async () => {
    const service = fakeService();
    await build(service);
    await app.inject({ method: 'GET', url: '/api/google-workspace/callback?state=a&state=b&code=c' });
    expect(service.handleCallback).toHaveBeenCalledWith({ code: 'c' });
  });

  it('callback: a thrown error still lands on the done page as failed, without the state or code', async () => {
    await build(fakeService({ handleCallback: async () => { throw new Error('db down'); } }));
    const res = await app.inject({ method: 'GET', url: '/api/google-workspace/callback?state=secret-state&code=secret-code' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/google-workspace/done?result=failed&restart=0');
  });
});
