// system.ts — System/environment snapshot + operator restart for the console
// System page (#1376, #1765).
//
// GET is read-only, non-secret: app version, Node runtime, timezone, and the
// tier → model routing map. Deliberately excludes anything sensitive (API keys,
// DB URL, vault contents).
//
// POST /api/system/restart triggers the same graceful shutdown path SIGTERM
// takes. Docker's `restart: unless-stopped` brings the process back — no
// Docker socket is mounted. Auth is session-cookie / bootstrap-secret only
// (`/api/system` is on the bearer-bypass list), so assertSecret is the gate.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventBus } from '../../../bus/bus.js';
import { createSystemRestart } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

/** Max operator restarts in {@link RESTART_WINDOW_MS}. In-process Fastify
 *  limiter plus a durable audit_log count so the window survives SIGTERM. */
export const RESTART_MAX = 3;
export const RESTART_WINDOW_MS = 5 * 60 * 1000;

/** One capability tier and the concrete model it currently routes to. */
export interface SystemModelTier {
  tier: string;
  model: string;
}

/** Read-only environment snapshot as resolved at process boot. */
export interface SystemSnapshot {
  /** Curia application version (root package.json). */
  version: string;
  /** Node.js runtime version, e.g. "v24.14.0". */
  nodeVersion: string;
  /** Timezone Curia operates in (config.timezone). */
  timezone: string;
  /** ISO timestamp of when this process started — powers the uptime display. */
  bootedAt: string;
  /** Capability-tier → model routing (ADR-014), plus the default tier. */
  models: {
    defaultTier: string;
    tiers: SystemModelTier[];
  };
}

export interface SystemRouteOptions {
  system: SystemSnapshot;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  bus: EventBus;
  logger: Logger;
  /**
   * Triggers graceful process shutdown so the supervisor (Docker
   * `restart: unless-stopped`) can bring Curia back. Injected for
   * testability — production passes SIGTERM, which takes the existing
   * shutdown(0) path in src/index.ts.
   */
  scheduleShutdown: () => void;
  /**
   * Count `system.restart` audit rows in the current cooldown window.
   * Fastify's in-memory limiter resets on process exit; this is the
   * durable half of the 3/5min cap. Tests inject a stub; production
   * reads audit_log. Omit to skip the durable check (unit tests that
   * only exercise the in-process limiter).
   */
  countRecentRestarts?: () => Promise<number>;
}

export async function systemRoutes(
  app: FastifyInstance,
  options: SystemRouteOptions,
): Promise<void> {
  const { system, webAppBootstrapSecret, sessions, bus, logger, scheduleShutdown, countRecentRestarts } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const RESTART_RATE = { config: { rateLimit: { max: RESTART_MAX, timeWindow: RESTART_WINDOW_MS } } };

  // -- GET /api/system — read-only environment snapshot --

  app.get('/api/system', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    return reply.send({ system });
  });

  // -- POST /api/system/restart — graceful process restart --
  //
  // 202 first, then schedule shutdown on the next tick so the response
  // flushes before the HTTP server closes. The audit event is published
  // (and therefore written to audit_log) before we schedule, while the
  // pool is still open.

  app.post('/api/system/restart', RESTART_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    if (countRecentRestarts) {
      let recent: number;
      try {
        recent = await countRecentRestarts();
      } catch (err) {
        logger.error({ err }, 'POST /api/system/restart: failed to read restart cooldown — process not restarted');
        return reply.status(500).send({
          error: 'Failed to check restart cooldown. The process was not restarted.',
        });
      }
      if (recent >= RESTART_MAX) {
        return reply.status(429).send({
          error: 'Too many restart attempts. Try again in a few minutes.',
        });
      }
    }

    try {
      await bus.publish('system', createSystemRestart({
        bootedAt: system.bootedAt,
        initiatedBy: 'operator',
      }));
    } catch (err) {
      logger.error({ err }, 'POST /api/system/restart: failed to publish audit event — process not restarted');
      return reply.status(500).send({
        error: 'Failed to record restart. The process was not restarted.',
      });
    }

    logger.warn(
      { bootedAt: system.bootedAt },
      'POST /api/system/restart: scheduling graceful shutdown',
    );

    setImmediate(() => {
      try {
        scheduleShutdown();
      } catch (err) {
        logger.error({ err }, 'POST /api/system/restart: scheduleShutdown threw — process may not exit');
      }
    });

    return reply.status(202).send({ restarting: true });
  });
}

/** Build the read-only system snapshot from boot-time inputs. */
export function resolveSystemSnapshot(input: {
  version: string;
  nodeVersion: string;
  timezone: string;
  bootedAt: string;
  modelRouting: { default_tier?: string; tiers: Record<string, { model: string }> };
}): SystemSnapshot {
  return {
    version: input.version,
    nodeVersion: input.nodeVersion,
    timezone: input.timezone,
    bootedAt: input.bootedAt,
    models: {
      defaultTier: input.modelRouting.default_tier ?? 'standard',
      // Preserve YAML declaration order (fast → standard → powerful).
      tiers: Object.entries(input.modelRouting.tiers).map(([tier, cfg]) => ({
        tier,
        model: cfg.model,
      })),
    },
  };
}
