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
import { CHANNEL_CATALOG } from '../../catalog.js';

// Allow-set of valid channel credential vault keys, derived once from the static catalog.
// A channel credential is stored as `channel.<channel>.<field.key>`; only the exact
// (channel, field) pairs the catalog declares are writable here. This mirrors the
// skill-declared-secret scope guard: the channel console can configure known credentials,
// but no arbitrary `channel.*` name may be written (e.g. `channel.email.bogus` is rejected).
// Private backing set — never exported directly. A `ReadonlySet` type annotation only guards
// at compile time; exporting the live object would let any importer `.add()` to the exact set
// these routes (and the #971 system-capture allowlist) trust. Consumers get a fresh copy via
// channelCredentialKeys() instead, so the writable allow-list can't be widened at runtime.
const CHANNEL_CREDENTIAL_KEYS: ReadonlySet<string> = new Set(
  CHANNEL_CATALOG.flatMap(descriptor =>
    descriptor.credentialFields.map(field => `channel.${descriptor.name}.${field.key}`),
  ),
);

/** A fresh copy of the writable channel-credential key set, derived once from the catalog.
 *  Returns a new Set each call so callers can spread/iterate it without being able to mutate
 *  the canonical backing set. Reused by the secret-capture system-name allowlist (#971). */
export function channelCredentialKeys(): ReadonlySet<string> {
  return new Set(CHANNEL_CREDENTIAL_KEYS);
}

/** True iff `name` is a valid channel credential key declared by the catalog. */
function isChannelCredentialKey(name: string): boolean {
  return CHANNEL_CREDENTIAL_KEYS.has(name);
}

/** The narrow slice of SecretsService these routes need — list names + set a string value. */
export interface VaultSecretsPort {
  list(): Promise<string[]>;
  set(name: string, value: string): Promise<void>;
}

/** Generous ceiling for a string secret (API keys, tokens). Structured/JSON secrets use
 *  a different storage path; this endpoint only sets 'string' secrets a skill declares. */
const MAX_SECRET_VALUE_LENGTH = 8192;

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
    // Upper bound (defense in depth): these are API-key-shaped string secrets, not blobs.
    // The global bodyLimit already caps this; the explicit limit keeps a tighter, clearer
    // ceiling on what an authenticated caller can stash under a declared key.
    if (value.length > MAX_SECRET_VALUE_LENGTH) {
      return reply.status(400).send({ error: `Secret value exceeds ${MAX_SECRET_VALUE_LENGTH} characters.` });
    }

    // Scope guard: a name may be set only if it is EITHER a secret some skill declares
    // OR a valid channel credential key from the catalog. This is the line between
    // "configure a declared secret / known channel credential" and "write any key into
    // the vault". Arbitrary `channel.*` names that aren't in the catalog are still rejected.
    const isSkillDeclared = registryService.declaredSecretNames().includes(name);
    if (!isSkillDeclared && !isChannelCredentialKey(name)) {
      request.log.info({ name }, 'vault set rejected: name not declared by any skill or channel');
      return reply.status(400).send({
        error: `'${name}' is not a required secret declared by any skill, ` +
          `nor a known channel credential. Only secrets a skill lists in ` +
          `install.requires_secrets, or channel credentials defined in the channel catalog, ` +
          `can be set here.`,
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
