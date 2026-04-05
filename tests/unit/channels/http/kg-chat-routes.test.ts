// Unit tests for the KG web app chat endpoints:
//   POST /api/kg/chat/messages — dispatch a message, await agent response
//   GET  /api/kg/chat/stream  — SSE event stream
//
// Focuses on the auth guard and the happy path. The full publish/wait contract
// is covered by the integration test suite; here we only need to verify that
// the routes are wired up correctly and enforce the session/secret auth.

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import type { Logger } from '../../../../src/logger.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeGraphRoutes } from '../../../../src/channels/http/routes/kg.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { EventRouter } from '../../../../src/channels/http/event-router.js';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

// Minimal pool mock — the chat endpoints never touch the DB.
function createPool(): Pick<Pool, 'query'> {
  return { query: vi.fn() } as unknown as Pick<Pool, 'query'>;
}

// Create a mock EventRouter whose waitForResponse resolves immediately with
// a canned reply so the route handler can complete synchronously in tests.
function createMockEventRouter(reply = 'Hello from Curia'): EventRouter {
  return {
    waitForResponse: vi.fn().mockResolvedValue(reply),
    cancelPending: vi.fn(),
    addSseClient: vi.fn().mockReturnValue(() => { /* cleanup noop */ }),
    setupSubscriptions: vi.fn(),
  } as unknown as EventRouter;
}

function createMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as EventBus;
}

describe('KG chat routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Auth: unauthenticated requests must be rejected ────────────────────

  it('POST /api/kg/chat/messages — 401 with no auth', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(knowledgeGraphRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      secureCookies: false,
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/chat/messages',
      payload: { message: 'hello' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/kg/chat/stream — 401 with no auth', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(knowledgeGraphRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      secureCookies: false,
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
    });

    // inject() can't hold an SSE connection open, but the auth guard fires
    // before hijack(), so we get a normal 401 response.
    const response = await app.inject({
      method: 'GET',
      url: '/api/kg/chat/stream',
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  // ── Happy path: authenticated via x-web-bootstrap-secret header ───────

  it('POST /api/kg/chat/messages — 200 with valid bootstrap-secret header', async () => {
    const bus = createMockBus();
    const eventRouter = createMockEventRouter('Hey there!');

    const app = Fastify();
    await app.register(cookie);
    await app.register(knowledgeGraphRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      secureCookies: false,
      bus,
      eventRouter,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'What is on the agenda?', conversationId: 'test-convo-1' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.reply).toBe('Hey there!');
    expect(body.conversationId).toBe('test-convo-1');

    // Verify the bus and eventRouter were called correctly.
    expect(bus.publish).toHaveBeenCalledOnce();
    expect(eventRouter.waitForResponse).toHaveBeenCalledWith('test-convo-1', expect.any(Number));

    await app.close();
  });

  it('POST /api/kg/chat/messages — 400 when message is empty', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(knowledgeGraphRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      secureCookies: false,
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/message/);
    await app.close();
  });

  it('POST /api/kg/chat/messages — auto-generates conversationId when omitted', async () => {
    const bus = createMockBus();
    const eventRouter = createMockEventRouter('reply');

    const app = Fastify();
    await app.register(cookie);
    await app.register(knowledgeGraphRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      secureCookies: false,
      bus,
      eventRouter,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'hi' },
    });

    expect(response.statusCode).toBe(200);
    // A generated conversationId should be returned and match the waiter call.
    const body = response.json();
    expect(typeof body.conversationId).toBe('string');
    expect(body.conversationId.length).toBeGreaterThan(0);
    expect(eventRouter.waitForResponse).toHaveBeenCalledWith(body.conversationId, expect.any(Number));

    await app.close();
  });

  // ── 503 when the secret is not configured ─────────────────────────────

  it('POST /api/kg/chat/messages — 503 when webAppBootstrapSecret is undefined', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(knowledgeGraphRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: undefined,
      secureCookies: false,
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/chat/messages',
      payload: { message: 'hello' },
    });

    // assertSecret returns 503 when the secret is not configured (feature disabled).
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
