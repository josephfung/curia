// channel-registry.ts — HTTP routes for the channel registry management UI.
// Session-cookie or x-web-bootstrap-secret auth (same pattern as registry.ts/vault.ts).
// Only mounted when webAppBootstrapSecret + channelRegistryService are configured.
//
//   GET    /api/registry/channels                 — list all channels with derived state
//   POST   /api/registry/channels/:name/install
//   POST   /api/registry/channels/:name/enable
//   POST   /api/registry/channels/:name/disable
//   DELETE /api/registry/channels/:name           — uninstall

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChannelRegistryService } from '../../../registry/channel-registry-service.js';
import { ChannelGuardError } from '../../../registry/channel-registry-types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface ChannelRegistryRouteOptions {
  channelRegistryService: ChannelRegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

const ACTOR = 'web-console'; // no per-user identity in the console today (same as registry routes)

export async function channelRegistryRoutes(
  app: FastifyInstance,
  options: ChannelRegistryRouteOptions,
): Promise<void> {
  const { channelRegistryService: svc, webAppBootstrapSecret, sessions } = options;

  // Stricter per-route rate limit: 30 req/min per IP. These routes check credentials on
  // every call — still brute-force-sensitive. Mirrors registry.ts's AUTH_RATE.
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // Auth helper — validates session cookie or bootstrap secret on every request.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- GET /api/registry/channels — list all channels with derived state --

  app.get('/api/registry/channels', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ channels: await svc.list() });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/channels failed');
      return reply.status(500).send({ error: 'Failed to list channels. Check server logs.' });
    }
  });

  // -- POST state-change actions: install, enable, disable; DELETE uninstall --
  //
  // A single factory handles all four so the auth + error-handling pattern isn't repeated.
  // ChannelGuardError (unknown channel, not-installed enable, unresolvable creds, non-toggleable
  // disable/uninstall) are caller errors → 400. All other errors are infrastructure → 500.
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
        if (err instanceof ChannelGuardError) {
          // Expected validation rejection — bad request from the caller.
          request.log.info({ err, name, op }, `channel ${op} rejected: guard`);
          return reply.status(400).send({ error: err.message });
        }
        // Unexpected failure — DB error, invariant violation, etc.
        request.log.error({ err, name, op }, `channel ${op} failed unexpectedly`);
        return reply.status(500).send({ error: 'Operation failed. Check server logs.' });
      }
    };

  app.post('/api/registry/channels/:name/install', AUTH_RATE, action('install'));
  app.post('/api/registry/channels/:name/enable', AUTH_RATE, action('enable'));
  app.post('/api/registry/channels/:name/disable', AUTH_RATE, action('disable'));
  app.delete('/api/registry/channels/:name', AUTH_RATE, action('uninstall'));
}
