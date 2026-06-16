// security-headers.test.ts — verifies the baseline security response headers are set
// on every HTTP response, including non-2xx ones. Mirrors the bare-Fastify + inject
// harness used by the route tests.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSecurityHeaders } from './security-headers.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
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
  await instance.ready();
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
});
