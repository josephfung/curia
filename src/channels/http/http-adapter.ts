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
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
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
import { identityRoutes } from './routes/identity.js';
import type { OfficeIdentityService } from '../../identity/service.js';
import type { ContactService } from '../../contacts/contact-service.js';

export interface HttpAdapterConfig {
  bus: EventBus;
  logger: Logger;
  pool: Pool;
  agentRegistry: AgentRegistry;
  port: number;
  apiToken: string | undefined;
  webAppBootstrapSecret: string | undefined;
  appOrigin: string | undefined;
  agentNames: string[];
  skillNames: string[];
  schedulerService?: SchedulerService;
  identityService?: OfficeIdentityService;
  contactService: ContactService;
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
      appOrigin,
    } = this.config;

    // Register shared bus subscriptions BEFORE starting the server.
    // One subscriber per event type, dispatches to HTTP clients via Maps/Sets.
    this.eventRouter.setupSubscriptions(bus);

    // Cookie parsing — required for the KG session cookie auth flow.
    await this.app.register(cookie);

    // Rate limiting — global baseline, with tighter per-route overrides on auth endpoints.
    // Prevents brute-force against the bootstrap secret and general DoS.
    await this.app.register(rateLimit, {
      max: 200,
      timeWindow: '1 minute',
    });

    // CORS — restricted to APP_ORIGIN in production; disabled (no ACAO header) in dev.
    // 'origin: false' means Fastify sends no Access-Control-Allow-Origin header,
    // which is safe for same-origin browser requests on localhost.
    await this.app.register(cors, {
      origin: appOrigin ?? false,
      credentials: true, // needed so the browser sends the session cookie cross-origin
    });

    // Auth hook — runs before every request
    this.app.addHook('onRequest', async (request, reply) => {
      // Skip auth for health endpoint — it's used by load balancers and monitors.
      // Use routeOptions.url (the registered pattern) so query strings don't break the match.
      const routeUrl = request.routeOptions.url ?? '';
      if (routeUrl === '/api/health') return;
      // KG web app routes bypass bearer auth — the app shell, static assets, and
      // /auth exchange need no token; /api/kg/* routes enforce their own session/secret.
      // Identity routes bypass bearer auth — they enforce their own bootstrap secret auth.
      if (
        routeUrl === '/' ||
        routeUrl === '/auth' ||
        routeUrl.startsWith('/assets') ||
        routeUrl.startsWith('/api/kg') ||
        routeUrl.startsWith('/api/identity')
      ) return;

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

    // Identity routes — only registered when the bootstrap secret is configured.
    // Uses the same auth pattern as KG routes (x-web-bootstrap-secret header).
    if (webAppBootstrapSecret && this.config.identityService) {
      await this.app.register(identityRoutes, {
        identityService: this.config.identityService,
        webAppBootstrapSecret,
      });
    }

    // Only register KG routes when the secret is configured — if unset, the routes
    // don't exist at all (404) rather than leaking a 503 that reveals the feature exists.
    if (webAppBootstrapSecret) {
      // secureCookies: true only when serving over HTTPS (i.e. APP_ORIGIN is https://).
      // In local dev (no APP_ORIGIN), cookies are set without the Secure flag so they
      // work on plain http://localhost.
      const secureCookies = appOrigin?.startsWith('https://') ?? false;
      await this.app.register(knowledgeGraphRoutes, {
        pool,
        logger,
        webAppBootstrapSecret,
        secureCookies,
        // bus + eventRouter are passed through for the KG chat endpoints
        // (POST /api/kg/chat/messages, GET /api/kg/chat/stream). The chat routes
        // reuse the shared EventRouter subscriptions set up above so we don't leak
        // per-request bus subscribers.
        bus,
        eventRouter: this.eventRouter,
        contactService: this.config.contactService,
      });
    }

    // Start listening
    await this.app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'HTTP API listening');
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.config.logger.info('HTTP API stopped');
  }
}
