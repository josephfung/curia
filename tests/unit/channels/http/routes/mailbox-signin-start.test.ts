// mailbox-signin-start.test.ts — GET /api/mailbox-signin/start/:token (#2361) against a fake
// service. The route is token-only: the single-use token in the URL is the credential.

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { mailboxSignInRoutes } from '../../../../../src/channels/http/routes/mailbox-signin.js';
import type { SignInTokenRow } from '../../../../../src/nylas/mailbox-signin-service.js';
import type { NylasSignInReadiness } from '../../../../../src/nylas/signin-readiness.js';
import { MAILBOX_SIGNIN_SCOPES } from '../../../../../src/nylas/signin-readiness.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const ORIGIN = 'https://curia.example.com';
const READY: NylasSignInReadiness = { ready: true, applicationId: 'app-123', region: 'us' };

function row(over: Partial<SignInTokenRow> = {}): SignInTokenRow {
  return {
    target: 'principal', expected_email: 'boss@example.com', mailbox_label: null,
    expires_at: new Date(Date.now() + 60_000), consumed_at: null, created_at: new Date(),
    conversation_id: null, channel_id: null, agent_id: null, task_event_id: null, originator: null, resume_token: null,
    ...over,
  };
}

async function build(opts: {
  peek: SignInTokenRow | 'expired' | 'used' | 'not_found';
  readiness?: NylasSignInReadiness;
  apiKey?: string | undefined;
  rateLimit?: boolean;
  peekCalls?: string[];
}): Promise<FastifyInstance> {
  const app = Fastify();
  if (opts.rateLimit) await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  await app.register(mailboxSignInRoutes, {
    signIn: { peek: async (t: string) => { opts.peekCalls?.push(t); return opts.peek; } },
    readiness: async () => opts.readiness ?? READY,
    readApiKey: async () => ('apiKey' in opts ? opts.apiKey : 'nyk_test'),
    appOrigin: ORIGIN,
    logger: createSilentLogger(),
  });
  return app;
}

describe('GET /api/mailbox-signin/start/:token', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  it('redirects a live token to the Nylas hosted-auth URL with state and login_hint', async () => {
    app = await build({ peek: row() });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/RAW_TOKEN_123' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://api.us.nylas.com/v3/connect/auth');
    expect(location.searchParams.get('state')).toBe('RAW_TOKEN_123');
    expect(location.searchParams.get('login_hint')).toBe('boss@example.com');
    expect(location.searchParams.get('client_id')).toBe('app-123');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/mailbox-signin/callback`);
    expect(location.searchParams.get('scope')).toBe(MAILBOX_SIGNIN_SCOPES.join(' '));
    expect(res.headers.location).toContain('state=RAW_TOKEN_123');
  });

  it('omits login_hint when the link is for any account', async () => {
    app = await build({ peek: row({ target: 'curia', expected_email: null }) });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/T' });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.has('login_hint')).toBe(false);
  });

  it('uses the EU host for an EU application', async () => {
    app = await build({ peek: row(), readiness: { ready: true, applicationId: 'app-eu', region: 'eu' } });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/T' });
    expect(res.headers.location).toMatch(/^https:\/\/api\.eu\.nylas\.com\/v3\/connect\/auth\?/);
  });

  it('redirects an expired or spent token to the done page', async () => {
    app = await build({ peek: 'expired' });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/T' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mailbox-signin/done?result=expired');
  });

  it('redirects a spent token to the done page as used', async () => {
    app = await build({ peek: 'used' });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/T' });
    expect(res.headers.location).toBe('/mailbox-signin/done?result=used');
  });

  it('redirects an unknown token to the done page', async () => {
    app = await build({ peek: 'not_found' });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/T' });
    expect(res.headers.location).toBe('/mailbox-signin/done?result=not_found');
  });

  it('does not start a sign-in when Nylas is no longer ready, and sends no token anywhere', async () => {
    app = await build({ peek: row(), readiness: { ready: false, reason: 'nylas_unreachable', detail: 'x' } });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/SECRET_TOKEN_1' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mailbox-signin/done?result=failed');
    expect(res.headers.location).not.toContain('SECRET_TOKEN_1');
  });

  it('fails closed when the API key has gone missing', async () => {
    app = await build({ peek: row(), apiKey: undefined });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/T' });
    expect(res.headers.location).toBe('/mailbox-signin/done?result=failed');
  });

  it('peeks without spending the token (only the callback consumes it)', async () => {
    const peekCalls: string[] = [];
    app = await build({ peek: row(), peekCalls });
    await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/ABC' });
    expect(peekCalls).toEqual(['ABC']);
  });

  it('is rate-limited per IP', async () => {
    app = Fastify();
    await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
    await app.register(mailboxSignInRoutes, {
      signIn: { peek: async () => 'not_found' as const },
      readiness: async () => READY,
      readApiKey: async () => 'k',
      appOrigin: ORIGIN,
      logger: createSilentLogger(),
    });
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await app.inject({ method: 'GET', url: '/api/mailbox-signin/start/T' })).statusCode;
    }
    expect(last).toBe(429);
  });
});
