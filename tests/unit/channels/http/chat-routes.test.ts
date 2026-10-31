// Unit tests for the console chat endpoints:
//   POST /api/chat/messages — publish a message and ack 202 (reply arrives over SSE)
//   GET  /api/chat/stream  — SSE event stream
//
// Focuses on the auth guard and the ack contract. The reply delivery is covered
// by the SSE stream (see event-router tests); here we only need to verify that
// the routes are wired up correctly and enforce the session/secret auth.

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import type { Logger } from '../../../../src/logger.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRoutes } from '../../../../src/channels/http/routes/chat.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import { type EventRouter } from '../../../../src/channels/http/event-router.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';

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

// The shared thread is one SELECT. Tests that care about the id pass it in.
function createPool(conversationId = 'server-thread'): Pick<Pool, 'query'> {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM web_thread')) {
        return { rows: [{ conversation_id: conversationId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pick<Pool, 'query'>;
}

// The ack-and-stream POST no longer calls waitForResponse; it only publishes and
// returns 202. We keep addSseClient/setupSubscriptions for the stream route wiring.
function createMockEventRouter(): EventRouter {
  return {
    waitForResponse: vi.fn(),
    cancelPending: vi.fn(),
    addSseClient: vi.fn().mockReturnValue(() => { /* cleanup noop */ }),
    broadcastChatEvent: vi.fn(),
    setupSubscriptions: vi.fn(),
  } as unknown as EventRouter;
}

function createMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    stagePublish: vi.fn(async () => ({ deliver: vi.fn().mockResolvedValue(undefined) })),
    subscribe: vi.fn(),
  } as unknown as EventBus;
}

describe('chatRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Auth: unauthenticated requests must be rejected ────────────────────

  it('POST /api/chat/messages — 401 with no auth', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { message: 'hello' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/chat/stream — 401 with no auth', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
      sessions: new Map() as unknown as SessionStore,
    });

    // inject() can't hold an SSE connection open, but the auth guard fires
    // before hijack(), so we get a normal 401 response.
    const response = await app.inject({
      method: 'GET',
      url: '/api/chat/stream',
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  // ── Happy path: authenticated via x-web-bootstrap-secret header ───────

  it('POST /api/chat/messages — 202 ack with valid bootstrap-secret header', async () => {
    const bus = createMockBus();
    const eventRouter = createMockEventRouter();

    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus,
      eventRouter,
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'What is on the agenda?', conversationId: 'client-fork', clientMessageId: 'client-msg-1' },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    // The client id is ignored. The server thread is the one that was stored.
    expect(body.conversationId).toBe('server-thread');
    // The reply now arrives over SSE, not in the POST body.
    expect(body.reply).toBeUndefined();

    // The inbound is staged, not held for the agent turn.
    expect(bus.stagePublish).toHaveBeenCalledOnce();
    const published = vi.mocked(bus.stagePublish).mock.calls[0]?.[1];
    expect(published && 'payload' in published && published.payload).toMatchObject({
      conversationId: 'server-thread',
      content: 'What is on the agenda?',
    });
    expect(eventRouter.broadcastChatEvent).toHaveBeenCalledWith('server-thread', {
      type: 'user.message',
      conversation_id: 'server-thread',
      content: 'What is on the agenda?',
      client_message_id: 'client-msg-1',
    });
    expect(eventRouter.waitForResponse).not.toHaveBeenCalled();

    await app.close();
  });

  it('POST /api/chat/messages — 400 when message is empty', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/message/);
    await app.close();
  });

  it('POST /api/chat/messages — 500 when publish fails synchronously', async () => {
    const bus = {
      publish: vi.fn().mockRejectedValue(new Error('bus down')),
      stagePublish: vi.fn().mockRejectedValue(new Error('bus down')),
      subscribe: vi.fn(),
    } as unknown as EventBus;

    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus,
      eventRouter: createMockEventRouter(),
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'hello', conversationId: 'c-fail' },
    });

    expect(response.statusCode).toBe(500);
    await app.close();
  });

  it('POST /api/chat/messages — uses the shared thread when the client sends no id', async () => {
    const bus = createMockBus();
    const eventRouter = createMockEventRouter();

    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus,
      eventRouter,
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'hi' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ conversationId: 'server-thread' });
    expect(eventRouter.waitForResponse).not.toHaveBeenCalled();

    await app.close();
  });

  it('GET /api/chat/conversation — returns the shared thread id', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool('shared-abc') as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/chat/conversation',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ conversationId: 'shared-abc' });
    await app.close();
  });

  it('POST /api/chat/messages — echoes before subscriber delivery starts', async () => {
    const order: string[] = [];
    const bus = {
      stagePublish: vi.fn(async () => ({
        deliver: () => {
          order.push('deliver');
          return Promise.resolve();
        },
      })),
      subscribe: vi.fn(),
    } as unknown as EventBus;
    const eventRouter = createMockEventRouter();
    vi.mocked(eventRouter.broadcastChatEvent).mockImplementation(() => {
      order.push('echo');
    });
    const logger = createLogger();
    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger,
      webAppBootstrapSecret: 'test-secret',
      bus,
      eventRouter,
      sessions: new Map() as unknown as SessionStore,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'from the phone', conversationId: 'old-tab' },
    });
    expect(response.statusCode).toBe(202);
    expect(order).toEqual(['echo', 'deliver']);
    expect(logger.warn).toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/chat/messages — still acks when the echo broadcast throws', async () => {
    const eventRouter = createMockEventRouter();
    vi.mocked(eventRouter.broadcastChatEvent).mockImplementation(() => {
      throw new Error('sse write failed');
    });

    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus: createMockBus(),
      eventRouter,
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'x-web-bootstrap-secret': 'test-secret' },
      payload: { message: 'hello' },
    });

    expect(response.statusCode).toBe(202);
    await app.close();
  });

  // ── 503 when the secret is not configured ─────────────────────────────

  it('POST /api/chat/messages — 503 when webAppBootstrapSecret is undefined', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: undefined,
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { message: 'hello' },
    });

    // assertSecret returns 503 when the secret is not configured (feature disabled).
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});

describe('console shell routes', () => {
  it('GET /old — chatRoutes no longer defines this route (returns 404 in isolation; the SPA catch-all is not registered here)', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: createPool() as Pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'test-secret',
      bus: createMockBus(),
      eventRouter: createMockEventRouter(),
      sessions: new Map() as unknown as SessionStore,
    });

    const response = await app.inject({ method: 'GET', url: '/old' });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
