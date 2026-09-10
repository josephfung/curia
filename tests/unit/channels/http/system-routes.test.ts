import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  systemRoutes,
  resolveSystemSnapshot,
  type SystemSnapshot,
} from '../../../../src/channels/http/routes/system.js';
import { hashToken } from '../../../../src/channels/http/session-auth.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent, Layer } from '../../../../src/bus/events.js';

const SECRET = 'test-bootstrap-secret';

const SNAPSHOT: SystemSnapshot = {
  version: '0.41.0',
  nodeVersion: 'v24.14.0',
  timezone: 'America/Toronto',
  bootedAt: '2026-07-25T12:00:00.000Z',
  models: {
    defaultTier: 'standard',
    tiers: [
      { tier: 'fast', model: 'claude-haiku-4-5' },
      { tier: 'standard', model: 'claude-sonnet-4-6' },
      { tier: 'powerful', model: 'claude-opus-4-6' },
    ],
  },
};

function makeFakeBus(): EventBus & { published: Array<{ layer: Layer; event: BusEvent }> } {
  const published: Array<{ layer: Layer; event: BusEvent }> = [];
  return {
    published,
    async publish(layer: Layer, event: BusEvent) {
      published.push({ layer, event });
    },
  } as unknown as EventBus & { published: Array<{ layer: Layer; event: BusEvent }> };
}

describe('resolveSystemSnapshot', () => {
  it('maps tier → model preserving YAML order and passes runtime facts through', () => {
    const resolved = resolveSystemSnapshot({
      version: '0.41.0',
      nodeVersion: 'v24.14.0',
      timezone: 'America/Toronto',
      bootedAt: '2026-07-25T12:00:00.000Z',
      modelRouting: {
        default_tier: 'standard',
        tiers: {
          fast: { model: 'claude-haiku-4-5' },
          standard: { model: 'claude-sonnet-4-6' },
          powerful: { model: 'claude-opus-4-6' },
        },
      },
    });
    expect(resolved).toEqual(SNAPSHOT);
  });

  it('defaults the tier to "standard" when default_tier is omitted', () => {
    const resolved = resolveSystemSnapshot({
      version: '1.0.0',
      nodeVersion: 'v24.0.0',
      timezone: 'UTC',
      bootedAt: '2026-01-01T00:00:00.000Z',
      modelRouting: { tiers: { standard: { model: 'm' } } },
    });
    expect(resolved.models.defaultTier).toBe('standard');
    expect(resolved.models.tiers).toEqual([{ tier: 'standard', model: 'm' }]);
  });
});

describe('system routes', () => {
  const sessions = new Map<string, number>();

  beforeEach(() => sessions.clear());

  async function buildApp(opts: {
    bus?: EventBus;
    scheduleShutdown?: () => void;
    withRateLimit?: boolean;
  } = {}) {
    const app = Fastify();
    await app.register(cookie);
    if (opts.withRateLimit) await app.register(rateLimit, { global: false });
    await app.register(systemRoutes, {
      system: SNAPSHOT,
      webAppBootstrapSecret: SECRET,
      sessions,
      bus: opts.bus ?? makeFakeBus(),
      logger: createSilentLogger(),
      scheduleShutdown: opts.scheduleShutdown ?? (() => { /* no-op */ }),
    });
    return app;
  }

  describe('GET /api/system', () => {
    it('returns the boot-time system snapshot', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/system',
        headers: { 'x-web-bootstrap-secret': SECRET },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ system: SNAPSHOT });
      await app.close();
    });

    it('accepts a valid session cookie', async () => {
      const token = 'valid-session-token';
      sessions.set(hashToken(token), Date.now() + 60_000);
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/system',
        headers: { cookie: `curia_session=${token}` },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('rejects unauthenticated requests', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/system' });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe('POST /api/system/restart', () => {
    it('returns 202, publishes system.restart, then schedules shutdown on the next tick', async () => {
      const bus = makeFakeBus();
      const scheduleShutdown = vi.fn();
      const app = await buildApp({ bus, scheduleShutdown });
      const res = await app.inject({
        method: 'POST',
        url: '/api/system/restart',
        headers: { 'x-web-bootstrap-secret': SECRET },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ restarting: true });
      expect(scheduleShutdown).not.toHaveBeenCalled();
      expect(bus.published).toHaveLength(1);
      const published = bus.published[0]!;
      expect(published.layer).toBe('system');
      expect(published.event.type).toBe('system.restart');
      if (published.event.type === 'system.restart') {
        expect(published.event.payload.bootedAt).toBe(SNAPSHOT.bootedAt);
        expect(published.event.payload.initiatedBy).toBe('operator');
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(scheduleShutdown).toHaveBeenCalledOnce();
      await app.close();
    });

    it('accepts a valid session cookie', async () => {
      const token = 'valid-session-token';
      sessions.set(hashToken(token), Date.now() + 60_000);
      const scheduleShutdown = vi.fn();
      const app = await buildApp({ scheduleShutdown });
      const res = await app.inject({
        method: 'POST',
        url: '/api/system/restart',
        headers: { cookie: `curia_session=${token}` },
      });
      expect(res.statusCode).toBe(202);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(scheduleShutdown).toHaveBeenCalledOnce();
      await app.close();
    });

    it('returns 401 without a valid session cookie or bootstrap secret and does not restart', async () => {
      const scheduleShutdown = vi.fn();
      const bus = makeFakeBus();
      const app = await buildApp({ bus, scheduleShutdown });
      const res = await app.inject({ method: 'POST', url: '/api/system/restart' });
      expect(res.statusCode).toBe(401);
      expect(bus.published).toHaveLength(0);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(scheduleShutdown).not.toHaveBeenCalled();
      await app.close();
    });

    it('does not restart when the audit publish fails', async () => {
      const scheduleShutdown = vi.fn();
      const bus = {
        async publish() {
          throw new Error('bus down');
        },
      } as unknown as EventBus;
      const app = await buildApp({ bus, scheduleShutdown });
      const res = await app.inject({
        method: 'POST',
        url: '/api/system/restart',
        headers: { 'x-web-bootstrap-secret': SECRET },
      });
      expect(res.statusCode).toBe(500);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(scheduleShutdown).not.toHaveBeenCalled();
      await app.close();
    });

    it('rate-limits tighter than the read route (3 per 5 minutes)', async () => {
      const scheduleShutdown = vi.fn();
      const app = await buildApp({ scheduleShutdown, withRateLimit: true });
      const headers = { 'x-web-bootstrap-secret': SECRET };
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await app.inject({ method: 'POST', url: '/api/system/restart', headers });
        statuses.push(r.statusCode);
      }
      expect(statuses.slice(0, 3).every(s => s === 202)).toBe(true);
      expect(statuses[3]).toBe(429);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(scheduleShutdown).toHaveBeenCalledTimes(3);
      await app.close();
    });
  });
});
