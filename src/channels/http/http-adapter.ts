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
import type { SchedulerService } from '../../scheduler/scheduler-service.js';
import { healthRoutes } from './routes/health.js';
import { agentRoutes } from './routes/agents.js';
import { jobRoutes } from './routes/jobs.js';
import { messageRoutes } from './routes/messages.js';
import { knowledgeGraphRoutes } from './routes/kg.js';

export interface HttpAdapterConfig {
  bus: EventBus;
  logger: Logger;
  pool: Pool;
  agentRegistry: AgentRegistry;
  port: number;
  apiToken: string | undefined;
  webAppBootstrapSecret: string | undefined;
  agentNames: string[];
  skillNames: string[];
  schedulerService?: SchedulerService;
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
      bodyLimit: 64 * 1024, // 64 KiB — generous for chat messages, prevents abuse
    });
  }

  async start(): Promise<void> {
    const {
      bus,
      logger,
      pool,
      agentRegistry,
      port,
      apiToken,
      agentNames,
      skillNames,
      webAppBootstrapSecret,
    } = this.config;

    // Register shared bus subscriptions BEFORE starting the server.
    // One subscriber per event type, dispatches to HTTP clients via Maps/Sets.
    this.eventRouter.setupSubscriptions(bus);

    // CORS — allow all origins in dev, restrict in production later
    await this.app.register(cors, { origin: true });

    // Auth hook — runs before every request
    this.app.addHook('onRequest', async (request, reply) => {
      // Skip auth for health endpoint — it's used by load balancers and monitors.
      // Use routeOptions.url (the registered pattern) so query strings don't break the match.
      const routeUrl = request.routeOptions.url ?? '';
      if (routeUrl === '/api/health') return;
      if (routeUrl.startsWith('/kg') || routeUrl.startsWith('/api/kg')) return;

      if (!validateBearerToken(request.headers.authorization, apiToken)) {
        return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token' });
      }
    });

    // Register routes — message routes receive the eventRouter, not raw bus
    await this.app.register(healthRoutes, { pool, logger, agentNames, skillNames });
    await this.app.register(agentRoutes, { agentRegistry });
    await this.app.register(messageRoutes, { bus, logger, eventRouter: this.eventRouter });

    if (this.config.schedulerService) {
      await this.app.register(jobRoutes, { schedulerService: this.config.schedulerService });
    }

    await this.app.register(knowledgeGraphRoutes, {
      pool,
      logger,
      webAppBootstrapSecret,
    });

    // Start listening
    await this.app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'HTTP API listening');
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.config.logger.info('HTTP API stopped');
  }
}
