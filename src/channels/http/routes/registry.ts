// registry.ts — HTTP routes for the skill/agent registry management UI.
// Session-cookie or x-web-bootstrap-secret auth (same pattern as autonomy.ts/kg.ts).
// Only mounted when webAppBootstrapSecret + registryService are configured.
//
//   GET    /api/registry/skills                  — list all skills with derived state
//   GET    /api/registry/agents                  — list all agents with derived state
//   POST   /api/registry/:kind/:name/install
//   POST   /api/registry/:kind/:name/enable
//   POST   /api/registry/:kind/:name/install-enable
//   POST   /api/registry/:kind/:name/disable
//   DELETE /api/registry/:kind/:name             — uninstall

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RegistryService } from '../../../registry/registry-service.js';
import type { RegistryKind } from '../../../registry/types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface RegistryRouteOptions {
  registryService: RegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

const ACTOR = 'web-app'; // no per-user identity in the console today (same as autonomy routes)

// Map the URL plural segment ('skills', 'agents') to the internal singular kind.
function parseKind(raw: string): RegistryKind | null {
  return raw === 'skills' ? 'skill' : raw === 'agents' ? 'agent' : null;
}

export async function registryRoutes(
  app: FastifyInstance,
  options: RegistryRouteOptions,
): Promise<void> {
  const { registryService, webAppBootstrapSecret, sessions } = options;

  // Stricter per-route rate limit: 30 req/min per IP.
  // These routes check credentials on every call — still brute-force-sensitive.
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // Auth helper — validates session cookie or bootstrap secret on every request.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- GET /api/registry/skills — list all skills with derived state --

  app.get('/api/registry/skills', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ skills: await registryService.list('skill') });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/skills failed');
      return reply.status(500).send({ error: 'Failed to list skills. Check server logs.' });
    }
  });

  // -- GET /api/registry/agents — list all agents with derived state --

  app.get('/api/registry/agents', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ agents: await registryService.list('agent') });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/agents failed');
      return reply.status(500).send({ error: 'Failed to list agents. Check server logs.' });
    }
  });

  // -- POST state-change actions: install, enable, install-enable, disable --
  //
  // A single factory function handles all four so the auth + error handling pattern
  // isn't repeated. Service guard failures (ghost install, not-installed enable)
  // are caller errors → 400; unexpected failures → 500 already logged by the caller.

  const action = (op: 'install' | 'enable' | 'install-enable' | 'disable') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAuth(request, reply)) return;
      const { kind: rawKind, name } = request.params as { kind: string; name: string };
      const kind = parseKind(rawKind);
      if (!kind) {
        return reply.status(400).send({
          error: `Unknown kind '${rawKind}' (expected 'skills' or 'agents')`,
        });
      }
      try {
        let entry;
        if (op === 'install') entry = await registryService.install(kind, name, ACTOR);
        else if (op === 'enable') entry = await registryService.enable(kind, name, ACTOR);
        else if (op === 'install-enable') entry = await registryService.installAndEnable(kind, name, ACTOR);
        else entry = await registryService.disable(kind, name, ACTOR);
        return reply.send({ entry });
      } catch (err) {
        // Service guard failures (ghost install, not-installed enable) are caller errors → 400.
        request.log.warn({ err, kind, name, op }, `registry ${op} rejected`);
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Operation failed' });
      }
    };

  app.post('/api/registry/:kind/:name/install', AUTH_RATE, action('install'));
  app.post('/api/registry/:kind/:name/enable', AUTH_RATE, action('enable'));
  app.post('/api/registry/:kind/:name/install-enable', AUTH_RATE, action('install-enable'));
  app.post('/api/registry/:kind/:name/disable', AUTH_RATE, action('disable'));

  // -- DELETE /api/registry/:kind/:name — uninstall --

  app.delete('/api/registry/:kind/:name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { kind: rawKind, name } = request.params as { kind: string; name: string };
    const kind = parseKind(rawKind);
    if (!kind) {
      return reply.status(400).send({ error: `Unknown kind '${rawKind}'` });
    }
    try {
      await registryService.uninstall(kind, name, ACTOR);
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err, kind, name }, 'registry uninstall failed');
      return reply.status(500).send({ error: 'Uninstall failed. Check server logs.' });
    }
  });
}
