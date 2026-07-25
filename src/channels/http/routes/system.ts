// system.ts — Read-only system/environment snapshot for the console System settings page (#1376).
//
// Values reflect the running process at boot: app version, Node runtime, the
// configured timezone, and the tier → model routing map. Read-only, non-secret;
// mirrors the memory-retention route pattern. Deliberately excludes anything
// sensitive (API keys, DB URL, vault contents).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertSecret, type SessionStore } from '../session-auth.js';

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
}

export async function systemRoutes(
  app: FastifyInstance,
  options: SystemRouteOptions,
): Promise<void> {
  const { system, webAppBootstrapSecret, sessions } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // -- GET /api/system — read-only environment snapshot --

  app.get('/api/system', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    return reply.send({ system });
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
