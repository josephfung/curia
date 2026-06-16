// security-headers.test.ts — verifies the baseline security response headers are set
// on every HTTP response, including non-2xx ones. Mirrors the bare-Fastify + inject
// harness used by the route tests.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { registerSecurityHeaders } from './security-headers.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  try {
    await app?.close();
  } catch (err) {
    // Surface a teardown failure in the test report rather than letting it become an
    // unhandled rejection between tests.
    throw new Error(`test teardown: app.close() failed: ${(err as Error).message}`, { cause: err });
  } finally {
    app = undefined;
  }
});

async function build(): Promise<FastifyInstance> {
  const instance = Fastify();
  // Register headers BEFORE routes/other hooks so the header is set even when a later
  // onRequest hook short-circuits the response (e.g. an auth 401).
  registerSecurityHeaders(instance);
  instance.get('/ok', async () => ({ ok: true }));
  // A hook that 401s before the handler — proves the header lands on short-circuited
  // responses (the case that matters for the API's auth gate).
  instance.get('/blocked', {
    onRequest: async (_req, reply) => reply.status(401).send({ error: 'no' }),
  }, async () => ({ never: true }));
  try {
    await instance.ready();
  } catch (err) {
    // Close the half-initialized instance before propagating so a failed ready() never
    // leaks an open server, and normalize the error with context.
    await instance.close().catch(() => {});
    throw new Error(`test Fastify instance failed to start: ${(err as Error).message}`, { cause: err });
  }
  return instance;
}

// Mirrors http-adapter.ts: register cors + rate-limit FIRST, then the security headers.
// Both plugins terminate requests in their own onRequest hooks (preflight OPTIONS, 429),
// so this proves the onSend-based header survives a plugin short-circuit that a later
// onRequest hook would miss.
async function buildWithPlugins(): Promise<FastifyInstance> {
  const instance = Fastify();
  try {
    await instance.register(rateLimit, { max: 1, timeWindow: '1 minute' });
    await instance.register(cors, { origin: 'https://example.com', credentials: true });
    registerSecurityHeaders(instance);
    instance.get('/ok', async () => ({ ok: true }));
    await instance.ready();
  } catch (err) {
    await instance.close().catch(() => {});
    throw new Error(`test Fastify instance failed to start: ${(err as Error).message}`, { cause: err });
  }
  return instance;
}

describe('registerSecurityHeaders', () => {
  it('sets X-Content-Type-Options: nosniff on a 200 response', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets the header on a 404 response', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets the header on a response short-circuited by a later onRequest hook (401)', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/blocked' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets the header on a 429 short-circuited by @fastify/rate-limit', async () => {
    app = await buildWithPlugins();
    const first = await app.inject({ method: 'GET', url: '/ok' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    const second = await app.inject({ method: 'GET', url: '/ok' });
    expect(second.statusCode).toBe(429);
    expect(second.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets the header on a CORS preflight (OPTIONS) handled by @fastify/cors', async () => {
    app = await buildWithPlugins();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/ok',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'GET' },
    });
    // @fastify/cors replies to the preflight directly (204 No Content).
    expect([200, 204]).toContain(res.statusCode);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
