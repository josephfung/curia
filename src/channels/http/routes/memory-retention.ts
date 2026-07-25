// memory-retention.ts — Read-only retention policy for the console Memory settings page (#1376).
//
// Values are the effective boot-time config (YAML → defaults). Editing is deferred;
// this endpoint exists so operators can see what the running process is using.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertSecret, type SessionStore } from '../session-auth.js';

/** Effective retention knobs as loaded at process boot. */
export interface MemoryRetentionSnapshot {
  workingMemoryTtlDays: number;
  scratchTtlDays: number;
  archiveThreshold: number;
  halfLifeDays: {
    slowDecay: number;
    fastDecay: number;
  };
  warnHoldBackDays: number;
  /** Always false for now — editing requires restart-aware plumbing. */
  editable: false;
}

export interface MemoryRetentionRouteOptions {
  retention: MemoryRetentionSnapshot;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

export async function memoryRetentionRoutes(
  app: FastifyInstance,
  options: MemoryRetentionRouteOptions,
): Promise<void> {
  const { retention, webAppBootstrapSecret, sessions } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // -- GET /api/memory/retention — effective boot-time retention policy (read-only) --

  app.get('/api/memory/retention', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    return reply.send({ retention });
  });
}

/** Resolve effective retention values from YAML config + known defaults. */
export function resolveMemoryRetentionSnapshot(yaml: {
  workingMemory?: { ttlDays?: number };
  documentWorkspace?: { scratchTtlDays?: number };
  dreaming?: {
    decay?: {
      archiveThreshold?: number;
      halfLifeDays?: { slow_decay?: number; fast_decay?: number };
      warnHoldBackDays?: number;
    };
  };
}): MemoryRetentionSnapshot {
  return {
    workingMemoryTtlDays: yaml.workingMemory?.ttlDays ?? 30,
    scratchTtlDays: yaml.documentWorkspace?.scratchTtlDays ?? 7,
    archiveThreshold: yaml.dreaming?.decay?.archiveThreshold ?? 0.05,
    halfLifeDays: {
      slowDecay: yaml.dreaming?.decay?.halfLifeDays?.slow_decay ?? 180,
      fastDecay: yaml.dreaming?.decay?.halfLifeDays?.fast_decay ?? 21,
    },
    warnHoldBackDays: yaml.dreaming?.decay?.warnHoldBackDays ?? 7,
    editable: false,
  };
}
