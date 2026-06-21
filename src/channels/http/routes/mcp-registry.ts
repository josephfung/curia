// src/channels/http/routes/mcp-registry.ts — HTTP routes for the MCP server registry UI.
// Session-cookie or x-web-bootstrap-secret auth, same pattern as channel-registry.ts.
//
//   GET    /api/registry/mcp                  — list all declared servers with derived state
//   POST   /api/registry/mcp/:name/install
//   POST   /api/registry/mcp/:name/enable     — gated on requiredResolvable
//   POST   /api/registry/mcp/:name/disable
//   DELETE /api/registry/mcp/:name            — uninstall; cascade-deletes exclusive vault keys

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { McpRegistryService } from '../../../registry/mcp-registry-service.js';
import { McpGuardError } from '../../../registry/mcp-registry-types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface McpRegistryRouteOptions {
  mcpRegistryService: McpRegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

const ACTOR = 'web-console'; // no per-user identity in the console today (same as channel-registry routes)

export async function mcpRegistryRoutes(
  app: FastifyInstance,
  options: McpRegistryRouteOptions,
): Promise<void> {
  const { mcpRegistryService: svc, webAppBootstrapSecret, sessions } = options;

  // Stricter per-route rate limit: 30 req/min per IP. These routes check credentials on
  // every call — still brute-force-sensitive. Mirrors channel-registry.ts's AUTH_RATE.
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // Auth helper — validates session cookie or bootstrap secret on every request.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- GET /api/registry/mcp — list all declared MCP servers with derived state --

  app.get('/api/registry/mcp', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ servers: await svc.list() });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/mcp failed');
      return reply.status(500).send({ error: 'Failed to list MCP servers. Check server logs.' });
    }
  });

  // -- POST state-change actions: install, enable, disable; DELETE uninstall --
  //
  // A single factory handles all four so the auth + error-handling pattern isn't repeated.
  // McpGuardError (unknown server, not-installed enable, unresolvable secrets, etc.) are
  // caller errors → 400. All other errors are infrastructure → 500.
  const action = (op: 'install' | 'enable' | 'disable' | 'uninstall') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAuth(request, reply)) return;
      const { name } = request.params as { name: string };
      try {
        if (op === 'uninstall') {
          await svc.uninstall(name, ACTOR);
          return reply.send({ ok: true });
        }
        const entry =
          op === 'install' ? await svc.install(name, ACTOR)
          : op === 'enable' ? await svc.enable(name, ACTOR)
          : await svc.disable(name, ACTOR);
        return reply.send({ entry });
      } catch (err) {
        if (err instanceof McpGuardError) {
          // Expected validation rejection — bad request from the caller.
          request.log.info({ err, name, op }, `MCP server ${op} rejected: guard`);
          return reply.status(400).send({ error: err.message });
        }
        // Unexpected failure — DB error, invariant violation, etc.
        request.log.error({ err, name, op }, `MCP server ${op} failed unexpectedly`);
        return reply.status(500).send({ error: 'Operation failed. Check server logs.' });
      }
    };

  app.post('/api/registry/mcp/:name/install', AUTH_RATE, action('install'));
  app.post('/api/registry/mcp/:name/enable',  AUTH_RATE, action('enable'));
  app.post('/api/registry/mcp/:name/disable', AUTH_RATE, action('disable'));
  app.delete('/api/registry/mcp/:name',       AUTH_RATE, action('uninstall'));
}
