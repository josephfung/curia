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
import { consoleRoutes } from './routes/console.js';
import { knowledgeGraphRoutes } from './routes/kg.js';
import { identityRoutes } from './routes/identity.js';
import { executiveRoutes } from './routes/executive.js';
import { autonomyRoutes } from './routes/autonomy.js';
import type { OfficeIdentityService } from '../../identity/service.js';
import type { ExecutiveProfileService } from '../../executive/service.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { AutonomyService } from '../../autonomy/autonomy-service.js';
import { type SessionStore } from './session-auth.js';

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
  executiveProfileService?: ExecutiveProfileService;
  contactService: ContactService;
  autonomyService?: AutonomyService;
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
      // routeOptions.url is the registered pattern (e.g. '/assets/index-CU1g6HdR.js' or '/*').
      // request.url is the actual request path (with query string).
      const routeUrl = request.routeOptions.url ?? '';

      // Non-API routes are the console app (static assets, SPA pages, /auth) — no bearer auth.
      //
      // @fastify/static v9 with wildcard:false scans consoleDist at startup and registers
      // an individual Fastify route per file (e.g. /assets/index-CU1g6HdR.js). These exact
      // paths don't match a '/*' check, so we gate on !startsWith('/api/') instead.
      //
      // We also check request.url as a fallback: the console '/*' catch-all absorbs GET
      // requests to unregistered paths, including probes like GET /api/nonexistent. Without
      // the request.url check, those would get routeUrl='/*', skip auth, and silently return
      // the React app HTML. Checking the actual URL keeps unregistered /api/ paths enforced.
      if (!routeUrl.startsWith('/api/') && !request.url.startsWith('/api/')) return;

      // These API routes use session-cookie auth and bypass bearer token enforcement.
      if (
        routeUrl === '/api/health' ||
        routeUrl.startsWith('/api/kg') ||
        routeUrl.startsWith('/api/identity') ||
        routeUrl.startsWith('/api/executive') ||
        routeUrl.startsWith('/api/jobs') ||
        routeUrl.startsWith('/api/autonomy')
      ) return;

      if (!validateBearerToken(request.headers.authorization, apiToken)) {
        // Audit-log the failure: IP, route, and whether a token was even provided.
        // Never log the token value — only that it was present and wrong vs absent.
        const reason = request.headers.authorization ? 'invalid_token' : 'missing_token';
        logger.warn({ ip: request.ip, route: routeUrl, reason }, 'HTTP auth failed');
        return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token' });
      }
    });

    // Shared session store — used by both KG and identity routes to validate browser sessions.
    // Sessions are set by POST /auth (KG routes) and verified by both route registrations.
    // Map keys are SHA-256 hashes of the raw token (matching the DB column).
    const sessions: SessionStore = new Map();

    // Restore active sessions from Postgres so existing browser tabs survive a process restart.
    // Only rows that haven't expired yet are loaded; the cookie expiry on the client enforces the
    // 24-hour TTL independently, so there's no risk of surfacing stale sessions here.
    try {
      const { rows } = await pool.query<{ token_hash: string; expires_at: Date }>(
        'SELECT token_hash, expires_at FROM sessions WHERE expires_at > NOW()',
      );
      for (const row of rows) {
        sessions.set(row.token_hash, row.expires_at.getTime());
      }
      if (rows.length > 0) {
        logger.info({ count: rows.length }, 'Restored sessions from Postgres');
      }
    } catch (err) {
      // 42P01 = undefined_table: migration 047 has not been applied yet. Log and continue so
      // operators see an actionable message; logins will fail until the migration runs.
      if ((err as { code?: string }).code === '42P01') {
        logger.error({ err }, 'Session table does not exist — run pending migrations; logins unavailable until migration 047 is applied');
      } else {
        // Any other error (bad credentials, connectivity) means we cannot guarantee sessions
        // are restored. Fail fast so the process is restarted into a clean state rather than
        // silently dropping every persisted session.
        logger.error({ err }, 'Failed to restore sessions from Postgres');
        throw err;
      }
    }

    // In-flight guard: if Postgres is slow and a prune DELETE takes longer than 60 s, the next
    // interval tick would launch a second concurrent DELETE against the same pool, eventually
    // exhausting connections. Skip the DB prune for this tick if one is already running.
    let isPruning = false;
    const pruneInterval = setInterval(() => {
      const now = Date.now();
      for (const [tokenHash, expiresAt] of sessions) {
        if (now > expiresAt) sessions.delete(tokenHash);
      }
      if (isPruning) return;
      isPruning = true;
      pool.query('DELETE FROM sessions WHERE expires_at < NOW()')
        .catch((err: unknown) => {
          logger.error({ err }, 'Session prune DELETE failed — Postgres session storage may be unavailable');
        })
        .finally(() => { isPruning = false; });
    }, 60_000);
    pruneInterval.unref();

    // Register routes — message routes receive the eventRouter, not raw bus
    await this.app.register(healthRoutes, { pool, logger, agentNames, skillNames });
    await this.app.register(agentRoutes, { agentRegistry });
    await this.app.register(messageRoutes, { bus, logger, eventRouter: this.eventRouter });

    if (this.config.schedulerService) {
      // Job routes use session-cookie auth (same as KG routes) so the dashboard can
      // access them without a Bearer token. webAppBootstrapSecret may be undefined when
      // the web UI is disabled; assertSecret will return 503 in that case.
      await this.app.register(jobRoutes, {
        schedulerService: this.config.schedulerService,
        webAppBootstrapSecret,
        sessions,
      });
    }

    // Identity routes — only registered when the bootstrap secret is configured.
    // Uses the same auth pattern as KG routes (x-web-bootstrap-secret header).
    if (webAppBootstrapSecret && this.config.identityService) {
      await this.app.register(identityRoutes, {
        identityService: this.config.identityService,
        webAppBootstrapSecret,
        sessions,
        pool,
      });
    }

    // Executive profile routes — same auth pattern as identity routes.
    // Only registered when the service is available (non-fatal initialization).
    if (webAppBootstrapSecret && this.config.executiveProfileService) {
      await this.app.register(executiveRoutes, {
        executiveProfileService: this.config.executiveProfileService,
        webAppBootstrapSecret,
        sessions,
      });
    }

    // Autonomy routes — same session-auth pattern as identity/executive routes.
    if (webAppBootstrapSecret && this.config.autonomyService) {
      await this.app.register(autonomyRoutes, {
        autonomyService: this.config.autonomyService,
        webAppBootstrapSecret,
        sessions,
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
        sessions,
      });
    }

    // Console app — registered last so all explicit API/KG/old routes above take priority
    // over its /* wildcard. The React app handles auth client-side via session cookie.
    await this.app.register(consoleRoutes);

    // Start listening
    await this.app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'HTTP API listening');
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.config.logger.info('HTTP API stopped');
  }
}
