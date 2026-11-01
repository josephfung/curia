import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { EventRouter } from '../../src/channels/http/event-router.js';
import { chatRoutes } from '../../src/channels/http/routes/chat.js';
import { healthRoutes } from '../../src/channels/http/routes/health.js';
import { agentRoutes } from '../../src/channels/http/routes/agents.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { validateBearerToken } from '../../src/channels/http/auth.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
const MOCK_PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock_000' } as const;
import pino from 'pino';
import type { HealthService } from '../../src/health/health-service.js';
import { makePrincipalContactResolver } from '../helpers/principal-contact-resolver.js';
import type { SessionStore } from '../../src/channels/http/session-auth.js';

// Minimal HealthService stub for integration tests that don't test health behavior.
// Returns a minimal ok response so GET /api/health stays up without a real DB.
function makeHealthServiceStub(): HealthService {
  return {
    getStatus: vi.fn().mockResolvedValue({
      status: 'ok',
      uptime_s: 0,
      checks: {
        db: 'ok', bus: 'ok', signal: 'skipped',
        email: 'skipped', browser: 'skipped',
        mcp: {},
        nylas_calendar: 'skipped',
        scheduler: 'ok',
      },
    }),
  } as unknown as HealthService;
}

const logger = pino({ level: 'silent' });
const WEB_SECRET = 'test-web-secret';

function chatAuthHeader(): Record<string, string> {
  return { 'x-web-bootstrap-secret': WEB_SECRET };
}

describe('HTTP API integration', () => {
  // forceCloseConnections: an SSE socket left open would otherwise stall app.close().
  const app = Fastify({ forceCloseConnections: true });
  const bus = new EventBus(logger);
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });

  const eventRouter = new EventRouter(logger);

  const mockProvider: LLMProvider = {
    id: 'mock',
    chat: async () => ({
      type: 'text' as const,
      content: 'Hello from the HTTP API!',
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: MOCK_PROVENANCE,
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

    // Principal resolver so Gate C on the relay (#1733) allows the reply.
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: makePrincipalContactResolver(),
    });
    dispatcher.register();

    app.register(chatRoutes, {
      pool: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('web_thread')) {
            return { rows: [{ conversation_id: 'test-conv-1' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      } as unknown as Pool,
      logger,
      webAppBootstrapSecret: WEB_SECRET,
      sessions: new Map() as SessionStore,
      bus,
      eventRouter,
    });
    app.register(healthRoutes, { healthService: makeHealthServiceStub() });
    app.register(agentRoutes, { agentRegistry });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/chat/messages acks 202 and the reply arrives on /api/chat/stream', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const chunks: string[] = [];
    let connected: () => void = () => {};
    const sawConnected = new Promise<void>((resolve) => { connected = resolve; });

    const stream = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/chat/stream?conversationId=test-conv-1',
        headers: chatAuthHeader(),
      },
      (res) => {
        expect(res.statusCode).toBe(200);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          chunks.push(chunk);
          if (chunk.includes(':connected') || chunks.join('').includes(':connected')) connected();
        });
      },
    );
    stream.on('error', () => { /* closed by the test */ });
    stream.end();

    try {
      await sawConnected;
      // :connected is written just before the client is registered. Yield so
      // addSseClient has run before the POST, or the reply can be missed.
      await new Promise((resolve) => { setImmediate(resolve); });

      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        headers: chatAuthHeader(),
        payload: {
          message: 'Hello!',
          conversationId: 'test-conv-1',
        },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ conversationId: 'test-conv-1' });
      await vi.waitFor(() => {
        expect(chunks.join('')).toContain('Hello from the HTTP API!');
      }, { timeout: 5_000 });
    } finally {
      stream.destroy();
    }
  });

  it('POST /api/chat/messages returns 400 for missing message', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: chatAuthHeader(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('message');
  });

  it('GET /api/health returns system status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('ok');
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

// Issue #189: routes that do not authenticate themselves must require a bearer token.
// /api/messages was the old sample route; /api/agents/status is the one that remains.
describe('HTTP API — bearer token authentication', () => {
  const TEST_TOKEN = 'test-secret-token-abc123';

  // Build a minimal Fastify app with the same onRequest hook as HttpAdapter.
  async function buildApp(token: string | undefined) {
    const app = Fastify();
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });

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

    app.register(healthRoutes, { healthService: makeHealthServiceStub() });
    app.register(agentRoutes, { agentRegistry });

    await app.ready();
    return app;
  }

  it('rejects GET /api/agents/status with no Authorization header (401)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agents/status',
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Unauthorized');
    } finally {
      await app.close();
    }
  });

  it('rejects GET /api/agents/status with a wrong token (401)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agents/status',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Unauthorized');
    } finally {
      await app.close();
    }
  });

  it('rejects GET /api/agents/status with empty bearer value (401)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agents/status',
        headers: { authorization: 'Bearer ' },
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Unauthorized');
    } finally {
      await app.close();
    }
  });

  it('accepts GET /api/agents/status with a valid token (200)', async () => {
    const app = await buildApp(TEST_TOKEN);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agents/status',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().agents).toHaveLength(1);
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
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('accepts GET /api/agents/status when no token is configured (auth disabled)', async () => {
    const app = await buildApp(undefined);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agents/status',
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
