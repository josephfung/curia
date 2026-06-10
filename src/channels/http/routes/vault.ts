// vault.ts — HTTP routes for the secrets vault, scoped to the skill-install flow (#939).
// Session-cookie or x-web-bootstrap-secret auth (same pattern as registry.ts/autonomy.ts).
// Only mounted when webAppBootstrapSecret + secretsService + registryService are configured.
//
//   GET  /api/vault/status            — names of configured secrets (keys only, never values)
//   PUT  /api/vault/secrets/:name      — set a secret value (body: { value })
//
// The PUT endpoint is deliberately narrow: a name may only be set if some installed-or-on-disk
// skill DECLARES it in install.requires_secrets. That keeps this a skill-secrets entry surface,
// not a general-purpose write-any-key vault editor — it can't clobber unrelated secrets.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RegistryService } from '../../../registry/registry-service.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

/** The narrow slice of SecretsService these routes need — list names + set a string value. */
export interface VaultSecretsPort {
  list(): Promise<string[]>;
  set(name: string, value: string): Promise<void>;
}

export interface VaultRouteOptions {
  secretsService: VaultSecretsPort;
  /** Used to scope writes to secrets that some skill actually declares it needs. */
  registryService: RegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

export async function vaultRoutes(
  app: FastifyInstance,
  options: VaultRouteOptions,
): Promise<void> {
  const { secretsService, registryService, webAppBootstrapSecret, sessions } = options;

  // Stricter per-route rate limit, matching the other credentialed admin routes.
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- GET /api/vault/status — names of configured secrets (no values) --
  app.get('/api/vault/status', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ configured_keys: await secretsService.list() });
    } catch (err) {
      request.log.error({ err }, 'GET /api/vault/status failed');
      return reply.status(500).send({ error: 'Failed to read vault status. Check server logs.' });
    }
  });

  // -- PUT /api/vault/secrets/:name — set a skill-declared secret value --
  app.put('/api/vault/secrets/:name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };
    const body = request.body as { value?: unknown } | undefined;
    const value = body?.value;

    // A secret value must be a non-empty string. Reject empties so the gate can't be
    // satisfied by storing a blank — a present-but-empty key is not "configured".
    if (typeof value !== 'string' || value.length === 0) {
      return reply.status(400).send({ error: 'Body must include a non-empty string "value".' });
    }

    // Scope guard: only secrets some skill declares may be set here. This is the line
    // between "configure a skill's secret" and "write any key into the vault".
    if (!registryService.declaredSecretNames().includes(name)) {
      request.log.info({ name }, 'vault set rejected: name not declared by any skill');
      return reply.status(400).send({
        error: `'${name}' is not a required secret declared by any skill. ` +
          `Only secrets a skill lists in install.requires_secrets can be set here.`,
      });
    }

    try {
      await secretsService.set(name, value);
      return reply.send({ ok: true });
    } catch (err) {
      // Do NOT log the value — only the key name.
      request.log.error({ err, name }, 'vault set failed');
      return reply.status(500).send({ error: 'Failed to save secret. Check server logs.' });
    }
  });
}
