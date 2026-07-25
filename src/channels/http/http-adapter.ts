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
//   - 'system' layer for tool.invoke/tool.result (observability — documented
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
import { registerSecurityHeaders } from './security-headers.js';
import { EventRouter } from './event-router.js';
import type { SchedulerService } from '../../scheduler/scheduler-service.js';
import { HealthService } from '../../health/health-service.js';
import { DEFAULT_HEALTH_CONFIG } from '../../config.js';
import { healthRoutes } from './routes/health.js';
import { agentRoutes } from './routes/agents.js';
import { jobRoutes } from './routes/jobs.js';
import { antfarmRoutes } from './routes/antfarm.js';
import { antfarmStaticRoutes } from './routes/antfarm-static.js';
import { antfarmAssetsRoutes } from './routes/antfarm-assets.js';
import { messageRoutes } from './routes/messages.js';
import { consoleRoutes } from './routes/console.js';
import { knowledgeGraphRoutes } from './routes/kg.js';
import { identityRoutes } from './routes/identity.js';
import { executiveRoutes } from './routes/executive.js';
import { autonomyRoutes } from './routes/autonomy.js';
import {
  memoryRetentionRoutes,
  type MemoryRetentionSnapshot,
} from './routes/memory-retention.js';
import { registryRoutes } from './routes/registry.js';
import { channelRegistryRoutes } from './routes/channel-registry.js';
import { mcpRegistryRoutes } from './routes/mcp-registry.js';
import { vaultRoutes } from './routes/vault.js';
import { emailAccountsRoutes } from './routes/email-accounts.js';
import { secretCaptureRoutes } from './routes/secret-capture.js';
import { setupRoutes } from './routes/setup.js';
import { smsWebhookRoutes } from '../sms/webhook-route.js';
import { SmsWebhookBridge } from '../sms/webhook-bridge.js';
import type { OfficeIdentityService } from '../../identity/service.js';
import type { ExecutiveProfileService } from '../../executive/service.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { AutonomyService } from '../../autonomy/autonomy-service.js';
import { type SessionStore } from './session-auth.js';
import type { Channel } from '../channel.js';
import type { AuditLogRepo } from '../../audit/audit-log-repo.js';

/**
 * Minimal HealthService for boot paths where a full HealthService wasn't provided
 * (e.g. test startup or degraded initialization). Only the db probe works;
 * all others are skipped because the optional adapter deps are absent.
 */
function createFallbackHealthService(pool: Pool, logger: Logger): HealthService {
  return new HealthService({
    db: pool,
    bus: null as never,    // bus not available here — bus check will report skipped/fail
    logger,
    scheduler: { lastTickAt: null },
    mcpSessions: [],
    modelRoutingConfig: {
      tiers: { fast: { model: '' }, standard: { model: '' }, powerful: { model: '' } },
      default_tier: 'standard',
    },
    config: DEFAULT_HEALTH_CONFIG,
  } as never);
}

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
  toolNames: string[];
  schedulerService?: SchedulerService;
  healthService?: HealthService;
  identityService?: OfficeIdentityService;
  executiveProfileService?: ExecutiveProfileService;
  contactService: ContactService;
  autonomyService?: AutonomyService;
  registryService?: import('../../registry/registry-service.js').RegistryService;
  /** Backs the /api/registry/channels/* routes (channel install/enable lifecycle). Mounted
   *  only when webAppBootstrapSecret is also configured. */
  channelRegistryService?: import('../../registry/channel-registry-service.js').ChannelRegistryService;
  /** Backs the /api/registry/mcp/* routes (MCP server install/enable lifecycle).
   *  Mounted only when webAppBootstrapSecret is also configured. */
  mcpRegistryService?: import('../../registry/mcp-registry-service.js').McpRegistryService;
  /** Backs the /api/vault/* routes (secrets status + skill-secret entry). Mounted only
   *  alongside registryService, which scopes which secret names may be written. */
  secretsService?: import('../../secrets/secrets-service.js').SecretsService;
  /** Backs the public /api/secret-capture/* routes (one-time tokenized secret capture, #971).
   *  Token-authed, so mounted independently of the bootstrap secret. */
  secretCaptureService?: import('../../secrets/secret-capture-service.js').SecretCaptureService;
  /**
   * True when the process booted without a principal contact and is running in
   * setup-required mode (email + Signal adapters are skipped until restart).
   * Drives the externalAdaptersPending flag on GET /api/setup/status so the
   * frontend can prompt the operator to restart once setup is complete.
   * Captured at boot; never changes over the process lifetime.
   */
  setupRequiredAtBoot: boolean;
  /**
   * ISO timestamp captured at the very start of main() so the wizard's post-
   * setup polling loop can detect a process restart (the value changes after
   * the supervisor brings the new process up). Exposed via GET /api/setup/status.
   */
  bootStartedAt: string;
  /**
   * Constrained LLM access for POST /api/setup/suggest-name (wizard starter-name
   * suggestion, #799). Optional — the endpoint degrades to "unavailable" when absent.
   */
  infraLlmService?: import('../../skills/infra-llm.js').InfraLlmService;
  /**
   * KG fact store for principal profile endpoints (#392). Optional — only available
   * when OPENAI_API_KEY is configured (entity memory requires embeddings). Passed
   * through to setupRoutes; working-hours fact storage is skipped gracefully when absent
   * (timezone/email/name writes still succeed).
   */
  entityMemory?: import('../../memory/entity-memory.js').EntityMemory;
  /** Backs GET /api/antfarm/timeline (replay window queries). */
  auditLogRepo?: AuditLogRepo;
  /**
   * Telnyx SMS webhook bridge — HttpAdapter mounts POST /api/webhooks/telnyx/sms
   * and delegates to the handler installed by SmsAdapter.start() (ADR-036).
   */
  smsWebhookBridge?: import('../sms/webhook-bridge.js').SmsWebhookBridge;
  /**
   * Effective boot-time KG/memory retention knobs for GET /api/memory/retention
   * (console Memory settings, #1376). Read-only snapshot — not hot-reloaded.
   */
  memoryRetention?: MemoryRetentionSnapshot;
}

export class HttpAdapter implements Channel {
  readonly name = 'http';
  readonly isToggleable = false;
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

    // Baseline security headers (X-Content-Type-Options: nosniff) on every response.
    // Implemented as an onSend hook, so it covers replies short-circuited by the cors /
    // rate-limit plugins above (preflight OPTIONS, 429) and the auth 401 below alike —
    // hook registration order does not affect onSend coverage.
    registerSecurityHeaders(this.app);

    // Auth hook — runs before every request
    this.app.addHook('onRequest', async (request, reply) => {
      // routeOptions.url is the registered pattern (e.g. '/assets/index-CU1g6HdR.js' or '/*').
      // request.url is the actual request path (with query string).
      const routeUrl = request.routeOptions.url ?? '';

      // Non-API routes are the console app (static assets, SPA pages, /auth) — no bearer auth.
      //
      // @fastify/static v9 with wildcard:false scans consoleDist at startup and registers
      // an individual Fastify route per file (e.g. /assets/index-CU1g6HdR.js). These exact
      // paths don't match a '/*' check, so we gate on isApiPath() instead.
      //
      // We also check request.url as a fallback: the console '/*' catch-all absorbs GET
      // requests to unregistered paths (e.g. GET /api/nonexistent, GET /api). Without
      // the request.url check, those get routeUrl='/*', skip auth, and silently return
      // the React app HTML. Checking the actual URL keeps unregistered /api paths enforced.
      //
      // isApiPath matches '/api' exactly and '/api/...' — avoids false positives like
      // '/api-docs' while catching the bare '/api' case that startsWith('/api/') misses.
      const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');
      const requestPath = (request.url ?? '').split('?')[0] ?? '';
      if (!isApiPath(routeUrl) && !isApiPath(requestPath)) return;

      // These API routes use session-cookie auth and bypass bearer token enforcement.
      // /api/setup/* is included because the onboarding wizard runs in the browser
      // with the same curia_session cookie / x-web-bootstrap-secret pair as the
      // identity routes; without this entry, requests get rejected at this hook
      // before assertSecret ever runs.
      if (
        routeUrl === '/api/health' ||
        routeUrl.startsWith('/api/kg') ||
        routeUrl.startsWith('/api/identity') ||
        routeUrl.startsWith('/api/executive') ||
        routeUrl.startsWith('/api/jobs') ||
        routeUrl.startsWith('/api/antfarm') ||
        routeUrl.startsWith('/api/autonomy') ||
        routeUrl.startsWith('/api/memory') ||
        routeUrl.startsWith('/api/registry') ||
        routeUrl.startsWith('/api/vault') ||
        // Secret-capture routes are token-authed (the single-use token in the URL is the
        // capability), so they bypass bearer auth and self-authorize via the token (#971).
        routeUrl.startsWith('/api/secret-capture') ||
        routeUrl.startsWith('/api/setup') ||
        // Telnyx SMS webhooks authenticate via Ed25519 signature, not bearer token (ADR-036).
        routeUrl.startsWith('/api/webhooks/telnyx')
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
    // Separate in-flight guard for the secret-capture token sweep (#971). Without it, a
    // DELETE that stalls (e.g. on a table lock) would let every 60s tick enqueue another
    // query against the same pool, piling up work and exhausting connections — the same
    // overlap the sessions guard prevents for its own DELETE.
    let isPruningCaptureTokens = false;
    const pruneInterval = setInterval(() => {
      const now = Date.now();
      for (const [tokenHash, expiresAt] of sessions) {
        if (now > expiresAt) sessions.delete(tokenHash);
      }

      // Prune expired secret-capture tokens. These rows hold only a hash + metadata (no secret
      // value), but expired tokens accumulate unbounded without a sweep. Guarded independently
      // of the session prune so neither can block or skip the other.
      if (this.config.secretCaptureService && !isPruningCaptureTokens) {
        isPruningCaptureTokens = true;
        pool.query('DELETE FROM secret_capture_tokens WHERE expires_at < NOW()')
          .catch((err: unknown) => {
            logger.error({ err }, 'Secret-capture token prune DELETE failed');
          })
          .finally(() => { isPruningCaptureTokens = false; });
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
    await this.app.register(healthRoutes, {
      healthService: this.config.healthService ?? createFallbackHealthService(pool, logger),
      logger,
    });
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
        // Needed so console-created jobs carry principal lineage (#1127).
        contactService: this.config.contactService,
        logger,
      });
    }

    if (this.config.auditLogRepo) {
      await this.app.register(antfarmRoutes, {
        auditLogRepo: this.config.auditLogRepo,
        eventRouter: this.eventRouter,
        webAppBootstrapSecret,
        sessions,
        logger,
      });
    }

    // Licensed Ant Farm art — auth-gated so LimeZu sheets are never world-downloadable.
    // Independent of auditLogRepo: art serving does not need the timeline data source.
    await this.app.register(antfarmAssetsRoutes, {
      webAppBootstrapSecret,
      sessions,
    });

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

    // Setup routes — onboarding wizard backend (issue #771). Same session-cookie
    // auth as identity routes, registered alongside them so the wizard can call
    // both without separate auth paths. Skipped when the bootstrap secret is
    // unset (no web UI configured, no wizard to back).
    if (webAppBootstrapSecret) {
      await this.app.register(setupRoutes, {
        webAppBootstrapSecret,
        sessions,
        pool,
        logger,
        setupRequiredAtBoot: this.config.setupRequiredAtBoot,
        bootStartedAt: this.config.bootStartedAt,
        // Inject the actual exit trigger here rather than have setup.ts call
        // process.exit directly; this keeps the route handler unit-testable
        // and keeps the "kill the process" capability narrowly scoped.
        //
        // No .unref() on the timer: the whole point of this scheduled exit is
        // to be the forcing function that brings the process down so the
        // supervisor can boot it fresh. .unref() would let Node exit early
        // (defeating the explicit exit), or — worse — let the process hang
        // if some other ref is keeping the loop alive and the timer never
        // fires. The 500ms delay is short enough that the active ref doesn't
        // meaningfully prolong a healthy shutdown.
        scheduleProcessExit: (delayMs) => {
          setTimeout(() => process.exit(0), delayMs);
        },
        infraLlmService: this.config.infraLlmService,
        contactService: this.config.contactService,
        entityMemory: this.config.entityMemory,
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

    // Memory retention (read-only) — console Memory settings page (#1376).
    if (webAppBootstrapSecret && this.config.memoryRetention) {
      await this.app.register(memoryRetentionRoutes, {
        retention: this.config.memoryRetention,
        webAppBootstrapSecret,
        sessions,
      });
    }

    // Registry routes — session-auth for the skill/agent management UI.
    if (webAppBootstrapSecret && this.config.registryService) {
      await this.app.register(registryRoutes, {
        registryService: this.config.registryService,
        webAppBootstrapSecret,
        sessions,
      });
    }

    // Vault routes — secrets status + credential entry for skill and MCP console UIs.
    // Mounted whenever either the skill registry OR the MCP registry is present, so the
    // credential-save endpoint works for MCP-only deployments (without a skill registry).
    if (
      webAppBootstrapSecret &&
      this.config.secretsService &&
      (this.config.registryService || this.config.mcpRegistryService)
    ) {
      await this.app.register(vaultRoutes, {
        secretsService: this.config.secretsService,
        registryService: this.config.registryService,
        mcpRegistryService: this.config.mcpRegistryService,
        webAppBootstrapSecret,
        sessions,
      });
    }

    // Channel registry routes — the channel install/enable lifecycle for the console UI.
    // Independent of the skill/agent registryService, so guarded only on the bootstrap
    // secret + its own service.
    if (webAppBootstrapSecret && this.config.channelRegistryService) {
      await this.app.register(channelRegistryRoutes, {
        channelRegistryService: this.config.channelRegistryService,
        webAppBootstrapSecret,
        sessions,
      });
    }

    // MCP registry routes — the MCP server install/enable lifecycle for the console UI.
    // Guards on the bootstrap secret + its own service, same pattern as channel registry.
    if (webAppBootstrapSecret && this.config.mcpRegistryService) {
      await this.app.register(mcpRegistryRoutes, {
        mcpRegistryService: this.config.mcpRegistryService,
        webAppBootstrapSecret,
        sessions,
      });
    }

    // Email accounts routes — CRUD for the email_accounts table + per-account Nylas
    // grant writes. Requires the bootstrap secret + secretsService (to write grant IDs
    // to the vault). The /api/registry/* auth bypass in the onRequest hook above covers
    // these routes so they never reach the Bearer-token gate.
    if (webAppBootstrapSecret && this.config.secretsService) {
      await this.app.register(emailAccountsRoutes, {
        pool,
        secretsService: this.config.secretsService,
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

    // Secret-capture routes (#971) — public, token-authed form for agent-initiated secret
    // capture. Independent of the bootstrap secret: the single-use token IS the credential,
    // and the routes are exempted from bearer auth in the onRequest hook above. Registered
    // before the console wildcard so /api/secret-capture/* resolves to the API, not the SPA.
    if (this.config.secretCaptureService) {
      await this.app.register(secretCaptureRoutes, {
        secretCaptureService: this.config.secretCaptureService,
        logger,
        // Pass the bus so a successful redeem publishes secret.captured for agent resume (#972).
        bus,
      });
    }

    // Telnyx SMS webhook — always mounted; SmsAdapter installs the handler on start.
    // Authenticates via Ed25519 (bearer-exempt above). Returns 503 when SMS is not started.
    await this.app.register(smsWebhookRoutes, {
      bridge: this.config.smsWebhookBridge ?? new SmsWebhookBridge(),
      logger,
    });

    // Ant Farm SPA — registered before the console wildcard so /antfarm/* resolves
    // to this static bundle instead of the console /* fallback.
    await this.app.register(antfarmStaticRoutes);

    // Console app — registered last so all explicit API/KG routes above take priority
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
