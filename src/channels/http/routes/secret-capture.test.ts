// secret-capture.test.ts — exercises the public secret-capture HTTP routes against a fake
// service. These routes are token-only (no bootstrap secret / session), so there is no auth
// header to set — the token in the URL is the sole credential.

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { secretCaptureRoutes, type SecretCapturePort } from './secret-capture.js';
import type { CaptureMetadata, RedeemResult } from '../../../secrets/secret-capture-service.js';
import { createSilentLogger } from '../../../logger.js';

/** A scripted fake: returns the configured metadata/redeem outcome and records redeem calls. */
function fakeService(opts: {
  metadata?: CaptureMetadata;
  redeem?: RedeemResult | (() => Promise<RedeemResult>);
}): SecretCapturePort & { redeemCalls: Array<{ token: string; value: string }> } {
  const redeemCalls: Array<{ token: string; value: string }> = [];
  return {
    redeemCalls,
    async getMetadata() {
      return opts.metadata ?? 'not_found';
    },
    async redeem(token: string, value: string) {
      redeemCalls.push({ token, value });
      if (typeof opts.redeem === 'function') return opts.redeem();
      return opts.redeem ?? 'ok';
    },
  };
}

async function build(service: SecretCapturePort, withRateLimit = false): Promise<FastifyInstance> {
  const app = Fastify();
  if (withRateLimit) await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  await app.register(secretCaptureRoutes, { secretCaptureService: service, logger: createSilentLogger() });
  return app;
}

describe('secret-capture routes', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  describe('GET /api/secret-capture/:token', () => {
    it('returns label + value_format for a live token', async () => {
      app = await build(fakeService({ metadata: { label: 'Flight password', valueFormat: 'string' } }));
      const res = await app.inject({ method: 'GET', url: '/api/secret-capture/abc' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ label: 'Flight password', value_format: 'string' });
    });

    it('returns 410 for an expired/consumed token', async () => {
      app = await build(fakeService({ metadata: 'expired' }));
      const res = await app.inject({ method: 'GET', url: '/api/secret-capture/abc' });
      expect(res.statusCode).toBe(410);
    });

    it('returns 404 for an unknown token', async () => {
      app = await build(fakeService({ metadata: 'not_found' }));
      const res = await app.inject({ method: 'GET', url: '/api/secret-capture/abc' });
      expect(res.statusCode).toBe(404);
    });

    it('never includes the vault key in the response', async () => {
      app = await build(fakeService({ metadata: { label: 'x', valueFormat: 'string' } }));
      const res = await app.inject({ method: 'GET', url: '/api/secret-capture/abc' });
      expect(res.body).not.toContain('secret_name');
      expect(res.body).not.toContain('user.');
    });
  });

  describe('POST /api/secret-capture/:token', () => {
    it('redeems a value and returns { ok: true }', async () => {
      const svc = fakeService({ redeem: 'ok' });
      app = await build(svc);
      const res = await app.inject({ method: 'POST', url: '/api/secret-capture/tok', payload: { value: 'hunter2' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(svc.redeemCalls).toEqual([{ token: 'tok', value: 'hunter2' }]);
    });

    it('rejects a missing/empty value with 400 (and never calls redeem)', async () => {
      const svc = fakeService({ redeem: 'ok' });
      app = await build(svc);
      const res = await app.inject({ method: 'POST', url: '/api/secret-capture/tok', payload: { value: '' } });
      expect(res.statusCode).toBe(400);
      expect(svc.redeemCalls).toHaveLength(0);
    });

    it('rejects an oversized value with 400', async () => {
      app = await build(fakeService({ redeem: 'ok' }));
      const res = await app.inject({ method: 'POST', url: '/api/secret-capture/tok', payload: { value: 'x'.repeat(9000) } });
      expect(res.statusCode).toBe(400);
    });

    it('maps expired → 410', async () => {
      app = await build(fakeService({ redeem: 'expired' }));
      const res = await app.inject({ method: 'POST', url: '/api/secret-capture/tok', payload: { value: 'v' } });
      expect(res.statusCode).toBe(410);
    });

    it('maps not_found → 404', async () => {
      app = await build(fakeService({ redeem: 'not_found' }));
      const res = await app.inject({ method: 'POST', url: '/api/secret-capture/tok', payload: { value: 'v' } });
      expect(res.statusCode).toBe(404);
    });

    it('maps invalid_json → 400', async () => {
      app = await build(fakeService({ redeem: 'invalid_json' }));
      const res = await app.inject({ method: 'POST', url: '/api/secret-capture/tok', payload: { value: 'not json' } });
      expect(res.statusCode).toBe(400);
    });

    it('maps a vault-write throw → 500', async () => {
      app = await build(fakeService({ redeem: () => Promise.reject(new Error('vault down')) }));
      const res = await app.inject({ method: 'POST', url: '/api/secret-capture/tok', payload: { value: 'v' } });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('rate limiting', () => {
    it('enforces a per-route cap when @fastify/rate-limit is registered', async () => {
      // Register the route with a real (tiny) limit to prove the config is wired.
      const app2 = Fastify();
      await app2.register(rateLimit, { global: false });
      await app2.register(secretCaptureRoutes, { secretCaptureService: fakeService({ metadata: 'not_found' }), logger: createSilentLogger() });
      try {
        let last = 0;
        // The route declares max 10 / 15 min. The 11th request in the window should 429.
        for (let i = 0; i < 12; i++) {
          const r = await app2.inject({ method: 'GET', url: '/api/secret-capture/abc' });
          last = r.statusCode;
        }
        expect(last).toBe(429);
      } finally {
        await app2.close();
      }
    });
  });
});
