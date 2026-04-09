import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { EventRouter } from '../../src/channels/http/event-router.js';
import { messageRoutes } from '../../src/channels/http/routes/messages.js';
import { healthRoutes } from '../../src/channels/http/routes/health.js';
import { agentRoutes } from '../../src/channels/http/routes/agents.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { validateBearerToken } from '../../src/channels/http/auth.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
import type { ContactResolver } from '../../src/contacts/contact-resolver.js';
import type { InboundSenderContext } from '../../src/contacts/types.js';
import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('HTTP API integration', () => {
  const app = Fastify();
  const bus = new EventBus(logger);
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });

  const mockPool = {
    query: async () => ({ rows: [{ '?column?': 1 }] }),
  } as unknown as Pool;

  const eventRouter = new EventRouter(logger);

  const mockProvider: LLMProvider = {
    id: 'mock',
    chat: async () => ({
      type: 'text' as const,
      content: 'Hello from the HTTP API!',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  };

  beforeAll(async () => {
    eventRouter.setupSubscriptions(bus);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a test agent.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();

    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    app.register(messageRoutes, { bus, logger, eventRouter });
    app.register(healthRoutes, { pool: mockPool, logger, agentNames: ['coordinator'], skillNames: ['web-fetch'] });
    app.register(agentRoutes, { agentRegistry });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/messages returns agent response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'Hello!',
        conversation_id: 'test-conv-1',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.content).toBe('Hello from the HTTP API!');
    expect(body.conversation_id).toBe('test-conv-1');
  });

  it('POST /api/messages returns 400 for missing content', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('content');
  });

  it('GET /api/health returns system status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.agents).toContain('coordinator');
    expect(body.skills).toContain('web-fetch');
  });

  it('GET /api/agents/status returns agent list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/status',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('coordinator');
    expect(body.agents[0].role).toBe('coordinator');
  });
});

// Issue #47: HTTP callers hang on rejected unknown-sender messages.
// This suite verifies that the reject policy returns 403 immediately
// instead of hanging until the 120-second response timeout (504).
describe('HTTP API — unknown_sender: reject policy', () => {
  const app = Fastify();
  const bus = new EventBus(logger);
  const eventRouter = new EventRouter(logger);

  const mockPool = {
    query: async () => ({ rows: [{ '?column?': 1 }] }),
  } as unknown as Pool;

  beforeAll(async () => {
    eventRouter.setupSubscriptions(bus);

    // Resolver always returns unknown sender
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: false,
        channel: 'http',
        senderId: 'stranger',
      } satisfies InboundSenderContext),
    } as unknown as ContactResolver;

    // Dispatcher configured with reject policy for the http channel
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: mockResolver,
      channelPolicies: { http: { trust: 'low', unknownSender: 'reject' } },
    });
    dispatcher.register();

    app.register(messageRoutes, { bus, logger, eventRouter });
    app.register(healthRoutes, { pool: mockPool, logger, agentNames: [], skillNames: [] });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/messages returns 403 immediately when sender is rejected', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'Hello from unknown sender',
        conversation_id: 'reject-test-conv-1',
        sender_id: 'stranger',
      },
    });

    // Must be 403, not 504 (timeout) — the response should come immediately
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('sender not authorized');
  });
});

// Issue #189: HTTP API channel must require token-based authentication.
// This suite exercises the auth middleware (onRequest hook) end-to-end.
// It builds a minimal Fastify app with the same hook as HttpAdapter
// to test auth independently from the message flow.
describe('HTTP API — bearer token authentication', () => {
  const TEST_TOKEN = 'test-secret-token-abc123';

  // Build a minimal Fastify app with the same onRequest hook as HttpAdapter.
  // We test auth in isolation here — message routing is covered by other suites.
  async function buildApp(token: string | undefined) {
    const app = Fastify();
    const bus = new EventBus(logger);
    const eventRouter = new EventRouter(logger);
    const mockPool = {
      query: async () => ({ rows: [{ '?column?': 1 }] }),
    } as unknown as Pool;

    eventRouter.setupSubscriptions(bus);

    // Register a minimal agent so POST /api/messages can return a response.
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: async () => ({
        type: 'text' as const,
        content: 'auth test response',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a test agent.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();
    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    // Auth hook — same logic as HttpAdapter.start()
    app.addHook('onRequest', async (request, reply) => {
      const routeUrl = request.routeOptions.url ?? '';
      if (routeUrl === '/api/health') return;
      // Mirror the full HttpAdapter exemption list — these routes use their own auth mechanisms.
      // None are registered in this test app, but the hook must match production exactly.
      if (
        routeUrl === '/' ||
        routeUrl === '/auth' ||
        routeUrl.startsWith('/assets') ||
        routeUrl.startsWith('/api/kg') ||
        routeUrl.startsWith('/api/identity') ||
        routeUrl.startsWith('/api/jobs')
      ) return;
      if (!validateBearerToken(request.headers.authorization, token)) {
        const reason = request.headers.authorization ? 'invalid_token' : 'missing_token';
        logger.warn({ ip: request.ip, route: routeUrl, reason }, 'HTTP auth failed');
        return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token' });
      }
    });

    app.register(messageRoutes, { bus, logger, eventRouter });
    app.register(healthRoutes, { pool: mockPool, logger, agentNames: ['coordinator'], skillNames: [] });

    await app.ready();
    return app;
  }

  it('rejects POST /api/messages with no Authorization header (401)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { content: 'hello' },
        // No headers — no Authorization
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Unauthorized');
    } finally {
      await app.close();
    }
  });

  it('rejects POST /api/messages with a wrong token (401)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { content: 'hello' },
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Unauthorized');
    } finally {
      await app.close();
    }
  });

  it('rejects POST /api/messages with empty bearer value (401)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { content: 'hello' },
        headers: { authorization: 'Bearer ' }, // Empty token value — "Bearer " with no value
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Unauthorized');
    } finally {
      await app.close();
    }
  });

  it('accepts POST /api/messages with a valid token (200)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { content: 'hello', conversation_id: 'auth-test-conv-1' },
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.conversation_id).toBe('auth-test-conv-1');
    } finally {
      await app.close();
    }
  });

  it('allows GET /api/health with no token (health is auth-exempt)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        // No Authorization header
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('accepts POST /api/messages when no token is configured (auth disabled)', async () => {
    const app = await buildApp(undefined); // auth disabled
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: { content: 'hello', conversation_id: 'auth-disabled-conv-1' },
        // No Authorization header
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
