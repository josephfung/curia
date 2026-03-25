import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { EventRouter } from '../../src/channels/http/event-router.js';
import { messageRoutes } from '../../src/channels/http/routes/messages.js';
import { healthRoutes } from '../../src/channels/http/routes/health.js';
import { agentRoutes } from '../../src/channels/http/routes/agents.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
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
