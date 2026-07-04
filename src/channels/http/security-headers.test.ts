// security-headers.test.ts — verifies the baseline security response headers are set
// on every HTTP response, including non-2xx ones. Mirrors the bare-Fastify + inject
// harness used by the route tests.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  registerSecurityHeaders,
  CONSOLE_CONTENT_SECURITY_POLICY,
  ANTFARM_CONTENT_SECURITY_POLICY,
} from './security-headers.js';

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
  instance.get('/html', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>ok</body></html>');
  });
  // Ant Farm SPA routes (served as HTML) — deep links resolve to the same index.html.
  instance.get('/antfarm/', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>antfarm</body></html>');
  });
  instance.get('/antfarm/deep/link', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>antfarm</body></html>');
  });
  // Bare /antfarm (no trailing slash) is NOT served by the antfarm bundle in prod — it
  // falls through to the console wildcard and returns console HTML. Model that here so the
  // test proves it keeps the strict console CSP, not the relaxed antfarm one.
  instance.get('/antfarm', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>console</body></html>');
  });
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

  it('does not set Content-Security-Policy on JSON responses', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  it('sets Content-Security-Policy and X-Frame-Options on HTML responses', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('locks script-src to self in the console CSP', async () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('cdn.tailwindcss.com');
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });

  it('does not allow data: images in the strict console CSP', async () => {
    // Regression guard: the console must not inherit the Ant Farm relaxation.
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain("img-src 'self'");
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('data:');
  });

  it('serves the Ant Farm CSP (img-src data: blob:) on /antfarm/ HTML responses', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/antfarm/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(ANTFARM_CONTENT_SECURITY_POLICY);
    // Both schemes are required: data: for Phaser's base64 boot textures, blob: for the
    // loader-fetched licensed art (XHR → URL.createObjectURL). Missing blob: silently
    // degrades the office to placeholders even though the assets serve fine.
    expect(res.headers['content-security-policy']).toContain("img-src 'self' data: blob:");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('serves the Ant Farm CSP on deep-linked /antfarm/* HTML (SPA fallback)', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/antfarm/deep/link?t=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(ANTFARM_CONTENT_SECURITY_POLICY);
  });

  it('keeps the strict console CSP on non-Ant-Farm HTML', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
  });

  it('keeps the strict console CSP on bare /antfarm (served by the console wildcard)', async () => {
    // Regression guard: bare /antfarm (no trailing slash) resolves to console HTML in prod,
    // so it must NOT receive the relaxed img-src data: policy.
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/antfarm' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
    expect(res.headers['content-security-policy']).not.toContain('data:');
  });

  it('keeps script-src strict in the Ant Farm CSP (only images are relaxed)', async () => {
    expect(ANTFARM_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(ANTFARM_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(ANTFARM_CONTENT_SECURITY_POLICY).toContain("img-src 'self' data: blob:");
  });
});
