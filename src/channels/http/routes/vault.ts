// vault.ts — HTTP routes for the secrets vault, scoped to the skill-install flow (#939).
// Session-cookie or x-web-bootstrap-secret auth (same pattern as registry.ts/autonomy.ts).
// Only mounted when webAppBootstrapSecret + secretsService + registryService are configured.
//
//   GET    /api/vault/status            — names of configured secrets (keys only, never values)
//   GET    /api/vault/secrets          — every allowlisted secret: set or not, required or optional,
//                                         and what declares it (#2453). Never values.
//   PUT    /api/vault/secrets/:name    — set a secret value (body: { value })
//   DELETE /api/vault/secrets/:name    — remove a secret (idempotent; refused while an enabled
//                                         component requires it, unless ?force=true)
//
// PUT and DELETE are deliberately narrow and share one allowlist (isAllowedVaultName): a name is
// accepted only if a skill, MCP server or channel declares it, or it is a per-account email grant
// or principal-mailbox key. That keeps this a declared-secrets surface, not a general-purpose
// write-any-key vault editor — it can't clobber or delete unrelated secrets. Every set and
// delete is audited by key name, never by value.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RegistryService } from '../../../registry/registry-service.js';
import type { McpRegistryService } from '../../../registry/mcp-registry-service.js';
import type { ChannelRegistryService } from '../../../registry/channel-registry-service.js';
import type { EventBus } from '../../../bus/bus.js';
import { createConfigChange } from '../../../bus/events.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { CHANNEL_CATALOG } from '../../catalog.js';
import { isPerAccountEmailGrantKey } from '../../email/email-account-secrets.js';

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

// The principal's own mailbox (#2409): the Nylas grant that calendar and the ceo-inbox tools
// act through, and the principal's address. Not a channel credential and not declared by
// any skill's install.requires_secrets, so without this an image install had no supported
// way to set them. #2361 replaces the grant with a sign-in link.
const PRINCIPAL_MAILBOX_KEYS: ReadonlySet<string> = new Set(['ceo_nylas_grant_id', 'ceo_self_email']);

// Shape check only (same pattern as the setup wizard's profile email): one @, no spaces,
// a dot in the domain.
const PRINCIPAL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A fresh copy of the principal-mailbox key set (see channelCredentialKeys for why a copy).
 *  Reused by the secret-capture system-name allowlist. */
export function principalMailboxKeys(): ReadonlySet<string> {
  return new Set(PRINCIPAL_MAILBOX_KEYS);
}

/** True iff `name` is a valid channel credential key declared by the catalog. */
function isChannelCredentialKey(name: string): boolean {
  return CHANNEL_CREDENTIAL_KEYS.has(name);
}

/** The narrow slice of SecretsService these routes need — list names, set a string value,
 *  remove a secret. */
export interface VaultSecretsPort {
  list(): Promise<string[]>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** What declares a vault secret, as shown on the console Secrets page. */
export interface VaultSecretDeclarer {
  kind: 'tool' | 'mcp' | 'channel' | 'principal-mailbox' | 'email-account';
  /** Tool, MCP server or channel name; the kind's own label for the other kinds. */
  name: string;
  /** Whether this declarer needs the secret (true) or merely improves with it (false). */
  required: boolean;
  /** Whether the declaring component is currently enabled. Always true for kinds that
   *  have no enabled state. */
  enabled: boolean;
  /** Skill-declared optional secrets say what the key adds. */
  purpose?: string;
}

export interface VaultSecretSummary {
  name: string;
  configured: boolean;
  required: boolean;
  declaredBy: VaultSecretDeclarer[];
}

/** Generous ceiling for a string secret (API keys, tokens). Structured/JSON secrets use
 *  a different storage path; this endpoint only sets 'string' secrets a skill declares. */
const MAX_SECRET_VALUE_LENGTH = 8192;

export interface VaultRouteOptions {
  secretsService: VaultSecretsPort;
  /** Optional: when present, declared skill secret keys are added to the write allowlist. */
  registryService?: RegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  /** Optional: when present, declared MCP secret keys are added to the write allowlist. */
  mcpRegistryService?: McpRegistryService;
  /** Optional: when present, a delete is refused while an enabled channel requires the key. */
  channelRegistryService?: ChannelRegistryService;
  /** Every set and delete is published here as a config.change audit event (#2453). */
  bus: EventBus;
}

/** The one allowlist check behind both PUT and DELETE (#2453): a name is accepted only if
 *  a skill declares it, a valid channel credential key from the catalog, a secret key
 *  declared by an installed MCP server, a per-account email grant key
 *  (channel.email.<name>.nylas_grant_id, written by the email-accounts console flow, #1101),
 *  or one of the principal-mailbox keys (#2409). This is the line between "manage a declared
 *  secret / known channel credential / per-account grant" and "touch any key in the vault".
 *  Arbitrary `channel.*` names outside the catalog or the grant pattern, and arbitrary MCP
 *  keys not declared in config, are rejected. */
export function isAllowedVaultName(
  name: string,
  deps: Pick<VaultRouteOptions, 'registryService' | 'mcpRegistryService'>,
): boolean {
  return (
    (deps.registryService?.declaredSecretNames().includes(name) ?? false) ||
    isChannelCredentialKey(name) ||
    (deps.mcpRegistryService?.declaredSecretKeys().includes(name) ?? false) ||
    isPerAccountEmailGrantKey(name) ||
    PRINCIPAL_MAILBOX_KEYS.has(name)
  );
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

  // Write-ahead audit for a set or delete (#2453), published as config.change. Carries the
  // key name only — never a value. If the row can't be written the change is refused: this
  // sends the 500 itself and returns false.
  async function auditChange(
    request: FastifyRequest,
    reply: FastifyReply,
    name: string,
    action: 'set' | 'deleted',
  ): Promise<boolean> {
    try {
      await options.bus.publish('system', createConfigChange({
        config_type: 'vault_secret',
        version: 0,
        previous_version: 0,
        changed_by: 'console',
        note: name,
        diff_summary: `${action === 'set' ? 'Set' : 'Deleted'} vault secret '${name}'`,
      }));
      return true;
    } catch (err) {
      request.log.error({ err, name, action }, 'vault change audit write failed — change refused');
      void reply.status(500).send({
        error: 'Nothing was changed: the change could not be audited, so it was not made. Check the server logs.',
      });
      return false;
    }
  }

  // Every declaration of a vault key across tools, MCP servers, channels and the principal
  // mailbox. Reads in-memory discovery plus the registries' enabled state; no vault values.
  async function collectDeclarations(): Promise<Map<string, VaultSecretDeclarer[]>> {
    const out = new Map<string, VaultSecretDeclarer[]>();
    const add = (name: string, d: VaultSecretDeclarer) => {
      const list = out.get(name) ?? [];
      list.push(d);
      out.set(name, list);
    };

    if (registryService) {
      for (const tool of await registryService.list('tool')) {
        const enabled = tool.state === 'enabled';
        for (const s of tool.metadata?.requiresSecrets ?? []) {
          add(s, { kind: 'tool', name: tool.name, required: true, enabled });
        }
        for (const s of tool.metadata?.optionalSecrets ?? []) {
          add(s.name, { kind: 'tool', name: tool.name, required: false, enabled, purpose: s.purpose });
        }
      }
    }

    if (options.mcpRegistryService) {
      const states = new Map((await options.mcpRegistryService.list()).map(e => [e.name, e.state === 'enabled']));
      for (const d of options.mcpRegistryService.secretDeclarations()) {
        add(d.key, { kind: 'mcp', name: d.server, required: d.required, enabled: states.get(d.server) ?? false });
      }
    }

    const channelStates = options.channelRegistryService
      ? new Map((await options.channelRegistryService.list()).map(e => [e.name, e.state === 'enabled']))
      : new Map<string, boolean>();
    for (const descriptor of CHANNEL_CATALOG) {
      for (const field of descriptor.credentialFields) {
        add(`channel.${descriptor.name}.${field.key}`, {
          kind: 'channel',
          name: descriptor.name,
          required: descriptor.requiredSecretKeys.includes(field.key),
          // Always-on channels (http, cli) have no registry row.
          enabled: channelStates.get(descriptor.name) ?? !descriptor.isToggleable,
        });
      }
    }

    for (const key of PRINCIPAL_MAILBOX_KEYS) {
      add(key, { kind: 'principal-mailbox', name: 'Principal mailbox', required: false, enabled: true });
    }
    return out;
  }

  // -- GET /api/vault/secrets — the allowlisted secrets with status and declarer (no values) --
  app.get('/api/vault/secrets', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const configured = new Set(await secretsService.list());
      const declarations = await collectDeclarations();
      // Per-account email grants are pattern-allowlisted, so they can only be listed once set.
      for (const name of configured) {
        if (isPerAccountEmailGrantKey(name) && !declarations.has(name)) {
          declarations.set(name, [{ kind: 'email-account', name: 'Email account', required: false, enabled: true }]);
        }
      }
      const secrets: VaultSecretSummary[] = [...declarations.entries()]
        .map(([name, declaredBy]) => ({
          name,
          configured: configured.has(name),
          required: declaredBy.some(d => d.required),
          declaredBy,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return reply.send({ secrets });
    } catch (err) {
      request.log.error({ err }, 'GET /api/vault/secrets failed');
      return reply.status(500).send({ error: 'Failed to read secrets. Check server logs.' });
    }
  });

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

    // Scope guard — the same allowlist DELETE uses (isAllowedVaultName).
    if (!isAllowedVaultName(name, options)) {
      request.log.info({ name }, 'vault set rejected: name not declared by any skill, MCP server, or channel');
      return reply.status(400).send({
        error: `'${name}' is not a secret declared by any skill or MCP server, ` +
          `nor a known channel credential. Only declared secrets can be set here.`,
      });
    }

    // ceo_self_email is the self-address filter for the principal's mailbox (reply-all
    // drafts drop it from CC). A value that is not an address would filter nothing.
    if (name === 'ceo_self_email' && !PRINCIPAL_EMAIL_RE.test(value.trim())) {
      return reply.status(400).send({ error: 'ceo_self_email must be an email address.' });
    }

    // Write-ahead audit: a change never lands without its audit row. Key name only.
    if (!await auditChange(request, reply, name, 'set')) return;

    try {
      await secretsService.set(name, value);
      return reply.send({ ok: true });
    } catch (err) {
      // Do NOT log the value — only the key name.
      request.log.error({ err, name }, 'vault set failed');
      return reply.status(500).send({ error: 'Failed to save secret. Check server logs.' });
    }
  });

  // -- DELETE /api/vault/secrets/:name — remove a declared secret (idempotent) --
  // Refused with 409 while an enabled tool, MCP server or channel requires the key, naming
  // what would stop working; the console confirms and retries with ?force=true. Deleting a
  // key that isn't set is a no-op: 200 with removed:false.
  app.delete('/api/vault/secrets/:name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };
    const force = (request.query as { force?: string } | undefined)?.force === 'true';

    if (!isAllowedVaultName(name, options)) {
      request.log.info({ name }, 'vault delete rejected: name not declared by any skill, MCP server, or channel');
      return reply.status(400).send({
        error: `'${name}' is not a secret declared by any skill or MCP server, ` +
          `nor a known channel credential. Only declared secrets can be removed here.`,
      });
    }

    try {
      if (!(await secretsService.list()).includes(name)) {
        return reply.send({ ok: true, removed: false });
      }

      const affected = ((await collectDeclarations()).get(name) ?? [])
        .filter(d => d.required && d.enabled && d.kind !== 'principal-mailbox');
      if (affected.length > 0 && !force) {
        return reply.status(409).send({
          error: `'${name}' is required by enabled ${affected.map(d => `${d.kind} '${d.name}'`).join(', ')}; ` +
            `removing it will stop them working until it is set again.`,
          affected: affected.map(d => ({ kind: d.kind, name: d.name })),
        });
      }

      if (!await auditChange(request, reply, name, 'deleted')) return;
      await secretsService.delete(name);
      return reply.send({ ok: true, removed: true });
    } catch (err) {
      request.log.error({ err, name }, 'vault delete failed');
      return reply.status(500).send({ error: 'Failed to remove secret. Check server logs.' });
    }
  });
}
