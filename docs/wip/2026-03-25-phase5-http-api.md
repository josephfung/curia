# Phase 5: HTTP API Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an HTTP API channel with REST endpoints for sending messages, SSE streaming for real-time events, health checks, agent status, and token-based authentication — enabling web dashboards, mobile apps, and external integrations to interact with Curia.

**Architecture:** A Fastify server runs alongside the CLI adapter, registered as a `channel` layer adapter on the bus. It translates HTTP requests into `inbound.message` events and SSE-streams `outbound.message` events back to connected clients. Authentication uses a configurable bearer token. The server is wired into the bootstrap orchestrator and participates in graceful shutdown.

**Tech Stack:** Fastify (fast, TypeScript-native, schema validation), pino (already used), vitest, `@fastify/cors`

**Reference specs:**
- `docs/specs/04-channels.md` — HTTP API channel spec, adapter interface, trust levels
- `docs/specs/08-operations.md` — health endpoint, config, deployment
- `docs/specs/02-agent-system.md` — agent status for the status endpoint

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/channels/http/http-adapter.ts` | Fastify server + HTTP channel adapter (routes, SSE, auth) |
| `src/channels/http/routes/messages.ts` | POST /api/messages, GET /api/messages/stream (SSE) |
| `src/channels/http/routes/health.ts` | GET /api/health |
| `src/channels/http/routes/agents.ts` | GET /api/agents/status |
| `src/channels/http/auth.ts` | Bearer token auth hook |
| `tests/unit/channels/http/auth.test.ts` | Auth middleware tests |
| `tests/unit/channels/http/health.test.ts` | Health endpoint tests |
| `tests/integration/http-api.test.ts` | End-to-end HTTP → bus → agent → SSE response |

### Modified Files

| File | Changes |
|---|---|
| `package.json` | Add `fastify`, `@fastify/cors` dependencies |
| `src/config.ts` | Add `httpPort`, `apiToken` config fields |
| `src/index.ts` | Start Fastify alongside CLI, wire into shutdown |

---

## Tasks

### Task 1: Add Fastify Dependencies and Config

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `tests/unit/config.test.ts`

- [ ] **Step 1: Install Fastify**

Run: `pnpm add fastify @fastify/cors`

- [ ] **Step 2: Update config.ts**

Read `src/config.ts` first. Add `httpPort` and `apiToken` fields:

```typescript
export interface Config {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  logLevel: string;
  httpPort: number;
  apiToken: string | undefined;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    databaseUrl,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    httpPort: parseInt(process.env.HTTP_PORT ?? '3000', 10),
    apiToken: process.env.API_TOKEN,
  };
}
```

- [ ] **Step 3: Update .env.example**

Add to `.env.example`:

```
# HTTP API
HTTP_PORT=3000
API_TOKEN=your-secret-token-here
```

- [ ] **Step 4: Run existing config tests**

Run: `pnpm test -- tests/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/config.ts .env.example
git commit -m "feat: add Fastify dependencies and HTTP config (port, API token)"
```

---

### Task 2: Bearer Token Auth

**Files:**
- Create: `src/channels/http/auth.ts`
- Create: `tests/unit/channels/http/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/channels/http/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateBearerToken } from '../../../../src/channels/http/auth.js';

describe('validateBearerToken', () => {
  it('returns true for a valid token', () => {
    expect(validateBearerToken('Bearer my-secret-token', 'my-secret-token')).toBe(true);
  });

  it('returns false for an invalid token', () => {
    expect(validateBearerToken('Bearer wrong-token', 'my-secret-token')).toBe(false);
  });

  it('returns false for missing Bearer prefix', () => {
    expect(validateBearerToken('my-secret-token', 'my-secret-token')).toBe(false);
  });

  it('returns false for empty authorization header', () => {
    expect(validateBearerToken('', 'my-secret-token')).toBe(false);
  });

  it('returns false for undefined authorization header', () => {
    expect(validateBearerToken(undefined, 'my-secret-token')).toBe(false);
  });

  it('returns true when no API token is configured (auth disabled)', () => {
    expect(validateBearerToken(undefined, undefined)).toBe(true);
  });

  it('returns true for any header when no API token is configured', () => {
    expect(validateBearerToken('Bearer anything', undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/channels/http/auth.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement auth**

Create `src/channels/http/auth.ts`:

```typescript
// auth.ts — bearer token authentication for the HTTP API.
//
// When API_TOKEN is configured, all HTTP requests must include
// an Authorization header with a matching bearer token. When
// API_TOKEN is not set, authentication is disabled (useful for
// local development).

import { timingSafeEqual } from 'node:crypto';

/**
 * Validate a bearer token from an Authorization header.
 * Returns true if:
 * - No API token is configured (auth disabled)
 * - The header contains a valid Bearer token matching the configured token
 *
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateBearerToken(
  authHeader: string | undefined,
  configuredToken: string | undefined,
): boolean {
  // If no token is configured, auth is disabled
  if (!configuredToken) return true;

  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const provided = authHeader.slice('Bearer '.length);

  // Timing-safe comparison to prevent timing attacks
  if (provided.length !== configuredToken.length) return false;

  return timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(configuredToken),
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- tests/unit/channels/http/auth.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/channels/http/auth.ts tests/unit/channels/http/auth.test.ts
git commit -m "feat: add bearer token auth for HTTP API (timing-safe comparison)"
```

---

### Task 3: Health Endpoint

**Files:**
- Create: `src/channels/http/routes/health.ts`
- Create: `tests/unit/channels/http/health.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/channels/http/health.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../../../../src/channels/http/routes/health.js';
import type { Pool } from 'pg';

describe('GET /api/health', () => {
  const mockPool = {
    query: async () => ({ rows: [{ '?column?': 1 }] }),
  } as unknown as Pool;

  const app = Fastify();

  beforeAll(async () => {
    app.register(healthRoutes, {
      pool: mockPool,
      agentNames: ['coordinator', 'research-analyst'],
      skillNames: ['web-fetch', 'delegate'],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with system status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.agents).toEqual(['coordinator', 'research-analyst']);
    expect(body.skills).toEqual(['web-fetch', 'delegate']);
    expect(body).toHaveProperty('uptime');
  });

  it('returns 503 when database is down', async () => {
    const failPool = {
      query: async () => { throw new Error('connection refused'); },
    } as unknown as Pool;

    const failApp = Fastify();
    failApp.register(healthRoutes, {
      pool: failPool,
      agentNames: ['coordinator'],
      skillNames: [],
    });
    await failApp.ready();

    const response = await failApp.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('disconnected');

    await failApp.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/channels/http/health.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement health routes**

Create `src/channels/http/routes/health.ts`:

```typescript
// health.ts — GET /api/health endpoint.
//
// Reports system status: database connectivity, registered agents,
// loaded skills, and process uptime. Returns 200 for healthy, 503
// for degraded (e.g., database is down).

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export interface HealthRouteOptions {
  pool: Pool;
  agentNames: string[];
  skillNames: string[];
}

export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  const { pool, agentNames, skillNames } = options;
  const startTime = Date.now();

  app.get('/api/health', async (_request, reply) => {
    let dbStatus = 'connected';

    try {
      await pool.query('SELECT 1');
    } catch {
      dbStatus = 'disconnected';
    }

    const status = dbStatus === 'connected' ? 'ok' : 'degraded';
    const statusCode = status === 'ok' ? 200 : 503;

    return reply.status(statusCode).send({
      status,
      database: dbStatus,
      agents: agentNames,
      skills: skillNames,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- tests/unit/channels/http/health.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/channels/http/routes/health.ts tests/unit/channels/http/health.test.ts
git commit -m "feat: add GET /api/health endpoint (DB status, agents, skills, uptime)"
```

---

### Task 4: Agent Status Endpoint

**Files:**
- Create: `src/channels/http/routes/agents.ts`

- [ ] **Step 1: Implement agent status routes**

Create `src/channels/http/routes/agents.ts`:

```typescript
// agents.ts — GET /api/agents/status endpoint.
//
// Returns a snapshot of all registered agents and their metadata.
// In Phase 5 this is a static list from the registry; future phases
// will add real-time agent state (idle/thinking/using_tool/etc.).

import type { FastifyInstance } from 'fastify';
import type { AgentRegistry } from '../../../agents/agent-registry.js';

export interface AgentRouteOptions {
  agentRegistry: AgentRegistry;
}

export async function agentRoutes(
  app: FastifyInstance,
  options: AgentRouteOptions,
): Promise<void> {
  const { agentRegistry } = options;

  app.get('/api/agents/status', async (_request, reply) => {
    const agents = agentRegistry.list().map(a => ({
      name: a.name,
      role: a.role,
      description: a.description,
      // TODO: Add real-time state (idle/thinking/using_tool) in Phase 6
      state: 'idle',
    }));

    return reply.send({ agents });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/channels/http/routes/agents.ts
git commit -m "feat: add GET /api/agents/status endpoint"
```

---

### Task 5: Event Router (shared subscriber pattern)

**Files:**
- Create: `src/channels/http/event-router.ts`

The HTTP adapter needs to dispatch bus events to many HTTP clients without
creating a new bus subscriber per request. The EventRouter registers ONE
subscriber per event type at startup and fans out to registered handlers.
This prevents subscriber leaks — handlers are added/removed via a Map and Set.

- [ ] **Step 1: Implement the event router**

Create `src/channels/http/event-router.ts`:

```typescript
// event-router.ts — shared subscriber pattern for the HTTP API.
//
// The EventBus has no unsubscribe mechanism. If we subscribed per-request,
// every POST and SSE connection would leak a permanent subscriber. Instead,
// the EventRouter registers ONE subscriber per event type at startup and
// dispatches to registered handlers via Maps and Sets.
//
// POST /api/messages registers a pending resolver keyed by conversationId.
// SSE connections register a writer function in a Set.
// Both are cleaned up when the request completes or the client disconnects.

import type { EventBus } from '../../bus/bus.js';
import type { BusEvent } from '../../bus/events.js';
import type { Logger } from '../../logger.js';
import type { ServerResponse } from 'node:http';

export interface PendingResponse {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface SseClient {
  res: ServerResponse;
  conversationId?: string; // Optional filter
}

/**
 * EventRouter registers shared bus subscribers and dispatches to HTTP clients.
 * Call setupSubscriptions() once at startup, then use the add/remove methods
 * per-request.
 */
export class EventRouter {
  private logger: Logger;
  /** Pending POST /api/messages responses, keyed by conversationId */
  private pendingResponses = new Map<string, PendingResponse>();
  /** Active SSE connections */
  private sseClients = new Set<SseClient>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register shared subscribers on the bus. Called once at startup.
   * Uses 'channel' layer for outbound.message (proper permission model)
   * and 'system' layer for observability events (skill.invoke, skill.result).
   */
  setupSubscriptions(bus: EventBus): void {
    // outbound.message — dispatches to pending POST resolvers and SSE clients
    bus.subscribe('outbound.message', 'channel', (event: BusEvent) => {
      if (event.type !== 'outbound.message') return;
      // Only handle messages for the HTTP channel
      if (event.payload.channelId !== 'http') return;

      const convId = event.payload.conversationId;

      // Resolve pending POST request if one is waiting for this conversation
      const pending = this.pendingResponses.get(convId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingResponses.delete(convId);
        pending.resolve(event.payload.content);
      }

      // Stream to all SSE clients (filtered by conversationId if set)
      const sseData = JSON.stringify({
        type: 'message',
        conversation_id: convId,
        content: event.payload.content,
        timestamp: event.timestamp,
      });
      for (const client of this.sseClients) {
        if (!client.conversationId || client.conversationId === convId) {
          client.res.write(`data: ${sseData}\n\n`);
        }
      }
    });

    // skill.invoke — observability stream for SSE clients
    bus.subscribe('skill.invoke', 'system', (event: BusEvent) => {
      if (event.type !== 'skill.invoke') return;
      const sseData = JSON.stringify({
        type: 'skill.invoke',
        agent: event.payload.agentId,
        skill: event.payload.skillName,
        conversation_id: event.payload.conversationId,
        timestamp: event.timestamp,
      });
      for (const client of this.sseClients) {
        if (!client.conversationId || client.conversationId === event.payload.conversationId) {
          client.res.write(`data: ${sseData}\n\n`);
        }
      }
    });

    // skill.result — observability stream for SSE clients
    bus.subscribe('skill.result', 'system', (event: BusEvent) => {
      if (event.type !== 'skill.result') return;
      const sseData = JSON.stringify({
        type: 'skill.result',
        agent: event.payload.agentId,
        skill: event.payload.skillName,
        success: event.payload.result.success,
        duration_ms: event.payload.durationMs,
        conversation_id: event.payload.conversationId,
        timestamp: event.timestamp,
      });
      for (const client of this.sseClients) {
        if (!client.conversationId || client.conversationId === event.payload.conversationId) {
          client.res.write(`data: ${sseData}\n\n`);
        }
      }
    });

    this.logger.info('HTTP event router subscriptions registered');
  }

  /** Register a pending POST response. Returns a promise that resolves with the response content. */
  waitForResponse(conversationId: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(conversationId);
        reject(new Error('Response timeout — the agent did not respond in time'));
      }, timeoutMs);

      this.pendingResponses.set(conversationId, { resolve, reject, timeout });
    });
  }

  /** Cancel a pending response (e.g., if publish fails). */
  cancelPending(conversationId: string): void {
    const pending = this.pendingResponses.get(conversationId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(conversationId);
    }
  }

  /** Register an SSE client. Returns a cleanup function. */
  addSseClient(client: SseClient): () => void {
    this.sseClients.add(client);
    this.logger.debug({ conversationId: client.conversationId }, 'SSE client connected');
    return () => {
      this.sseClients.delete(client);
      this.logger.debug({ conversationId: client.conversationId }, 'SSE client disconnected');
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/channels/http/event-router.ts
git commit -m "feat: add EventRouter — shared subscriber pattern for HTTP API (no leak)"
```

---

### Task 6: Messages Endpoint and SSE Stream

**Files:**
- Create: `src/channels/http/routes/messages.ts`

Routes use the EventRouter instead of subscribing directly to the bus.

- [ ] **Step 1: Implement message routes**

Create `src/channels/http/routes/messages.ts`:

```typescript
// messages.ts — message endpoints for the HTTP API channel.
//
// POST /api/messages — send a message and get the response.
// GET /api/messages/stream — SSE endpoint for real-time events.
//
// Both use the shared EventRouter to avoid subscriber leaks on the bus.
// The EventRouter registers ONE subscriber per event type at startup;
// individual requests register/deregister handlers via Maps and Sets.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EventBus } from '../../../bus/bus.js';
import { createInboundMessage } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import type { EventRouter } from '../event-router.js';

export interface MessageRouteOptions {
  bus: EventBus;
  logger: Logger;
  eventRouter: EventRouter;
}

// How long to wait for an agent response before timing out the POST request
const RESPONSE_TIMEOUT_MS = 120000;

export async function messageRoutes(
  app: FastifyInstance,
  options: MessageRouteOptions,
): Promise<void> {
  const { bus, logger, eventRouter } = options;

  /**
   * POST /api/messages — send a message, wait for response.
   *
   * Body: { content: string, conversation_id?: string, sender_id?: string }
   * Response: { conversation_id, content, agent_id }
   */
  app.post('/api/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      content?: string;
      conversation_id?: string;
      sender_id?: string;
    };

    if (!body?.content || typeof body.content !== 'string') {
      return reply.status(400).send({ error: 'Missing required field: content (string)' });
    }

    const conversationId = body.conversation_id ?? `http-${randomUUID()}`;
    const senderId = body.sender_id ?? 'http-user';

    // Register the pending response BEFORE publishing so we don't miss a fast reply
    const responsePromise = eventRouter.waitForResponse(conversationId, RESPONSE_TIMEOUT_MS);

    const inboundEvent = createInboundMessage({
      conversationId,
      channelId: 'http',
      senderId,
      content: body.content,
    });

    try {
      await bus.publish('channel', inboundEvent);
      const content = await responsePromise;

      return reply.send({
        conversation_id: conversationId,
        content,
        agent_id: 'coordinator',
      });
    } catch (err) {
      // Clean up the pending response if publish failed
      eventRouter.cancelPending(conversationId);
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, conversationId }, 'HTTP message handling failed');
      return reply.status(504).send({ error: message });
    }
  });

  /**
   * GET /api/messages/stream — SSE endpoint.
   *
   * Streams outbound.message, skill.invoke, and skill.result events.
   * Optionally filter by ?conversation_id=xxx
   */
  app.get('/api/messages/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { conversation_id?: string };

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering if behind a proxy
    });

    // Send initial keepalive comment
    reply.raw.write(':connected\n\n');

    // Register with the event router — returns a cleanup function
    const cleanup = eventRouter.addSseClient({
      res: reply.raw,
      conversationId: query.conversation_id,
    });

    // Clean up when client disconnects
    request.raw.on('close', cleanup);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/channels/http/routes/messages.ts
git commit -m "feat: add POST /api/messages and GET /api/messages/stream (via EventRouter)"
```

---

### Task 7: HTTP Adapter (Fastify server)

**Files:**
- Create: `src/channels/http/http-adapter.ts`

This ties the routes, auth, CORS, and EventRouter together into a single Fastify server.

- [ ] **Step 1: Implement the HTTP adapter**

Create `src/channels/http/http-adapter.ts`:

```typescript
// http-adapter.ts — Fastify-based HTTP channel adapter.
//
// Provides REST + SSE endpoints for external clients (dashboards, mobile apps,
// integrations). Uses the EventRouter (shared subscriber pattern) to avoid
// per-request bus subscriber leaks.
//
// Endpoints:
//   POST   /api/messages        — send a message, get response
//   GET    /api/messages/stream — SSE real-time event stream
//   GET    /api/health          — system health check
//   GET    /api/agents/status   — agent registry snapshot
//
// The adapter subscribes to the bus at startup via EventRouter:
//   - 'channel' layer for outbound.message (respects permission model)
//   - 'system' layer for skill.invoke/skill.result (observability — documented
//     privilege escalation for the HTTP channel since SSE needs to stream these)

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { Pool } from 'pg';
import type { AgentRegistry } from '../../agents/agent-registry.js';
import { validateBearerToken } from './auth.js';
import { EventRouter } from './event-router.js';
import { healthRoutes } from './routes/health.js';
import { agentRoutes } from './routes/agents.js';
import { messageRoutes } from './routes/messages.js';

export interface HttpAdapterConfig {
  bus: EventBus;
  logger: Logger;
  pool: Pool;
  agentRegistry: AgentRegistry;
  port: number;
  apiToken: string | undefined;
  agentNames: string[];
  skillNames: string[];
}

export class HttpAdapter {
  private app: FastifyInstance;
  private config: HttpAdapterConfig;
  private eventRouter: EventRouter;

  constructor(config: HttpAdapterConfig) {
    this.config = config;
    this.eventRouter = new EventRouter(config.logger);
    this.app = Fastify({
      logger: false, // We use our own pino logger, not Fastify's built-in
    });
  }

  async start(): Promise<void> {
    const { bus, logger, pool, agentRegistry, port, apiToken, agentNames, skillNames } = this.config;

    // Register shared bus subscriptions BEFORE starting the server.
    // One subscriber per event type, dispatches to HTTP clients via Maps/Sets.
    this.eventRouter.setupSubscriptions(bus);

    // CORS — allow all origins in dev, restrict in production later
    await this.app.register(cors, { origin: true });

    // Auth hook — runs before every request
    this.app.addHook('onRequest', async (request, reply) => {
      // Skip auth for health endpoint — it's used by load balancers and monitors
      if (request.url === '/api/health') return;

      if (!validateBearerToken(request.headers.authorization, apiToken)) {
        return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token' });
      }
    });

    // Register routes — message routes receive the eventRouter, not raw bus
    await this.app.register(healthRoutes, { pool, agentNames, skillNames });
    await this.app.register(agentRoutes, { agentRegistry });
    await this.app.register(messageRoutes, { bus, logger, eventRouter: this.eventRouter });

    // Start listening
    await this.app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'HTTP API listening');
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.config.logger.info('HTTP API stopped');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/channels/http/http-adapter.ts
git commit -m "feat: add HttpAdapter (Fastify server with EventRouter, auth, CORS)"
```

---

### Task 8: Bootstrap Integration

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update index.ts**

Read the existing file. Add the HTTP adapter import and wire it in.

Add import at the top:

```typescript
import { HttpAdapter } from './channels/http/http-adapter.js';
```

After the dispatcher registration and before the shutdown handler, add:

```typescript
  // HTTP API channel — REST + SSE endpoints for external clients.
  // Runs alongside the CLI channel so both can be used simultaneously.
  const httpAdapter = new HttpAdapter({
    bus,
    logger,
    pool,
    agentRegistry,
    port: config.httpPort,
    apiToken: config.apiToken,
    agentNames: agentConfigs.map(c => c.name),
    skillNames: skillRegistry.list().map(s => s.manifest.name),
  });

  try {
    await httpAdapter.start();
  } catch (err) {
    logger.fatal({ err }, 'Failed to start HTTP API');
    process.exit(1);
  }
```

Update the shutdown handler to also stop the HTTP adapter:

```typescript
  const shutdown = async () => {
    logger.info('Shutting down...');
    try {
      await httpAdapter.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping HTTP API during shutdown');
    }
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'Error closing database pool during shutdown');
    }
    process.exit(0);
  };
```

- [ ] **Step 2: Update .env with API_TOKEN**

Add to the actual `.env` file (not `.env.example` — that was done in Task 1):

```
API_TOKEN=dev-token-change-in-production
HTTP_PORT=3000
```

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 4: Run type check**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire HTTP API into bootstrap (alongside CLI, with graceful shutdown)"
```

---

### Task 9: Integration Test

**Files:**
- Create: `tests/integration/http-api.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/http-api.test.ts`:

```typescript
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

  // Shared event router — same pattern as production HttpAdapter
  const eventRouter = new EventRouter(logger);

  // Mock LLM that returns a text response
  const mockProvider: LLMProvider = {
    id: 'mock',
    chat: async () => ({
      type: 'text' as const,
      content: 'Hello from the HTTP API!',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  };

  beforeAll(async () => {
    // Set up event router subscriptions BEFORE registering routes
    eventRouter.setupSubscriptions(bus);

    // Set up agent and dispatcher on the bus
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

    // Register routes — message routes get the eventRouter
    app.register(messageRoutes, { bus, logger, eventRouter });
    app.register(healthRoutes, { pool: mockPool, agentNames: ['coordinator'], skillNames: ['web-fetch'] });
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
```

- [ ] **Step 2: Run integration test**

Run: `pnpm test -- tests/integration/http-api.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/integration/http-api.test.ts
git commit -m "test: add HTTP API integration tests (messages, health, agents)"
```

---

### Task 10: Final Verification & PR

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 2: Run type check**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 4: Manual smoke test**

Run: `pnpm local` (in the worktree with .env symlinked)

Test the HTTP API:

```bash
# Health check (no auth needed)
curl http://localhost:3000/api/health

# Send a message (with auth)
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-token-change-in-production" \
  -d '{"content": "What is on example.com?"}'

# SSE stream (in a separate terminal)
curl -N http://localhost:3000/api/messages/stream \
  -H "Authorization: Bearer dev-token-change-in-production"
```

- [ ] **Step 5: Push and create PR**

```bash
git push -u origin feat/phase5-http-api
```
