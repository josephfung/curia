// mailbox-signin-callback.test.ts — GET /api/mailbox-signin/callback (#2361). The logic is
// tested against Postgres in tests/integration/mailbox-signin-callback.test.ts; this pins the
// route: what reaches the handler and what the browser is redirected to.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mailboxSignInRoutes, type MailboxSignInRouteOptions } from '../../../../../src/channels/http/routes/mailbox-signin.js';
import { createSilentLogger } from '../../../../../src/logger.js';

async function build(callback: MailboxSignInRouteOptions['callback'], processStartedAt?: string): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(mailboxSignInRoutes, {
    signIn: { peek: async () => 'not_found' as const },
    readiness: async () => ({ ready: false, reason: 'no_api_key', detail: '' }),
    readApiKey: async () => undefined,
    appOrigin: 'https://curia.example.com',
    logger: createSilentLogger(),
    ...(callback ? { callback } : {}),
    ...(processStartedAt ? { processStartedAt } : {}),
  });
  return app;
}

describe('GET /api/mailbox-signin/callback', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  it('hands the query to the handler and redirects to the done page with outcome, target and restart only', async () => {
    const callback = vi.fn(async () => ({ outcome: 'connected' as const, target: 'curia' as const, restartScheduled: true }));
    app = await build(callback);
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/callback?state=STATE_RAW&code=CODE_RAW' });
    expect(callback).toHaveBeenCalledWith({ state: 'STATE_RAW', code: 'CODE_RAW' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mailbox-signin/done?result=connected&target=curia&restart=1');
    expect(res.headers.location).not.toContain('STATE_RAW');
    expect(res.headers.location).not.toContain('CODE_RAW');
  });

  it('with a restart, adds this process’s start (since) for the done page to wait on (#2697)', async () => {
    app = await build(vi.fn(async () => ({ outcome: 'connected' as const, target: 'curia' as const, restartScheduled: true })), '2026-11-20T10:00:00.000Z');
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/callback?state=S&code=C' });
    expect(res.headers.location).toBe('/mailbox-signin/done?result=connected&target=curia&restart=1&since=2026-11-20T10%3A00%3A00.000Z');
  });

  it('passes error and error_description, ignores non-string and unknown params', async () => {
    const callback = vi.fn(async () => ({ outcome: 'admin_blocked' as const, target: 'principal' as const, restartScheduled: false }));
    app = await build(callback);
    const res = await app.inject({
      method: 'GET',
      url: '/api/mailbox-signin/callback?state=S&error=access_denied&error_description=admin_policy_enforced&code=a&code=b&extra=1',
    });
    expect(callback).toHaveBeenCalledWith({ state: 'S', error: 'access_denied', error_description: 'admin_policy_enforced' });
    expect(res.headers.location).toBe('/mailbox-signin/done?result=admin_blocked&target=principal&restart=0');
  });

  it('leaves the target out when no link was claimed', async () => {
    app = await build(async () => ({ outcome: 'failed' as const, restartScheduled: false }));
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/callback?state=S&code=C' });
    expect(res.headers.location).toBe('/mailbox-signin/done?result=failed&restart=0');
  });

  it('a spent link redirects with result=used (K)', async () => {
    app = await build(async () => ({ outcome: 'used' as const, restartScheduled: false }));
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/callback?state=S&code=C' });
    expect(res.headers.location).toBe('/mailbox-signin/done?result=used&restart=0');
  });

  it('never answers 500: a throwing handler still redirects to failed', async () => {
    app = await build(async () => { throw new Error('boom'); });
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/callback?state=S&code=C' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mailbox-signin/done?result=failed&restart=0');
  });

  it('redirects to failed when the callback is not wired', async () => {
    app = await build(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/mailbox-signin/callback?state=S&code=C' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mailbox-signin/done?result=failed&restart=0');
  });
});
