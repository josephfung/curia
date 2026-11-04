// vault.ts — HTTP routes for the secrets vault, scoped to the skill-install flow (#939).
// Session-cookie or x-web-bootstrap-secret auth (same pattern as registry.ts/autonomy.ts).
// Only mounted when webAppBootstrapSecret + secretsService + registryService are configured.
//
//   GET    /api/vault/status                — names of configured secrets (keys only, never values)
//   GET    /api/vault/secrets              — every secret in the vault (personal user.*, platform keys,
//                                             system/declared, and orphans) plus declared-but-unset ones:
//                                             set or not, required or optional, what declares it, dates
//                                             and last use (#2453). Never values.
//   GET    /api/vault/secrets/:name/uses   — the newest recorded reads of one secret (?limit=1..20, default 5)
//   PUT    /api/vault/secrets/:name        — set a declared secret value (body: { value })
//   DELETE /api/vault/secrets/:name        — remove a declared, personal or orphaned secret (idempotent;
//                                             refused while an enabled component requires it, unless
//                                             ?force=true)
//   POST   /api/vault/user-secrets/preview — the user.* name a create would use, and whether it exists
//   POST   /api/vault/user-secrets         — create or replace a personal user.* secret with sign-in details
//   PATCH  /api/vault/user-secrets/:name   — edit a personal secret's value and/or sign-in details
//
// Platform keys (platform-keys.ts) are read-only here: PUT, DELETE and PATCH refuse them with 403
// before anything else runs. They are a deployment concern, not a console one.
//
// PUT is deliberately narrow (isAllowedVaultName): a name is accepted only if a skill, MCP server
// or channel declares it, or it is a per-account email grant or principal-mailbox key. That keeps
// it a declared-secrets surface, not a general-purpose write-any-key vault editor. DELETE also
// accepts any name already in the vault (personal keys and orphans), so a stale key can be removed;
// it still can't name a key into existence. Personal keys are written only through the user-secrets
// routes, which always name under user.*. Every set, delete and details edit is audited by key
// name, never by value.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RegistryService } from '../../../registry/registry-service.js';
import type { McpRegistryService } from '../../../registry/mcp-registry-service.js';
import type { ChannelRegistryService } from '../../../registry/channel-registry-service.js';
import type { EventBus } from '../../../bus/bus.js';
import { createSecretChanged } from '../../../bus/events.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { CHANNEL_CATALOG } from '../../catalog.js';
import { emailAccountGrantSecretName, isPerAccountEmailGrantKey } from '../../email/email-account-secrets.js';
import type { EmailAccountsRepo } from '../../email/email-accounts-repo.js';
import { actorFromRequest } from './sessions.js';
import { isPlatformVaultKey, platformKeyLabel } from '../../../secrets/platform-keys.js';
import type { SecretMetadata, UserSecretDetailsPatch } from '../../../secrets/secrets-service.js';
import type { SecretUsagePort } from '../../../secrets/secret-usage-repo.js';
import { consoleSecretNameInput, resolveUserSecretName, USER_SECRET_PREFIX } from '../../../secrets/user-secret-name.js';
import { hasUserSecretDetails, parseUserSecretDetails, type UserSecretDetails } from '../../../secrets/user-secret-details.js';

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

/** The narrow slice of SecretsService these routes need — list names and metadata, set a
 *  string value, remove a secret, and manage a user.* key's sign-in details. */
export interface VaultSecretsPort {
  list(): Promise<string[]>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  listMetadata(): Promise<SecretMetadata[]>;
  listUserNames(): Promise<string[]>;
  listUserDetails(): Promise<Map<string, UserSecretDetails>>;
  upsertUserDetails(name: string, d: UserSecretDetails): Promise<void>;
  patchUserDetails(name: string, p: UserSecretDetailsPatch): Promise<void>;
  deleteUserDetails(name: string): Promise<void>;
}

/** What declares a vault secret, as shown on the console Secrets page. */
export interface VaultSecretDeclarer {
  kind: 'tool' | 'mcp' | 'channel' | 'principal-mailbox' | 'email-account' | 'platform';
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

export type VaultSecretKind = 'personal' | 'system' | 'platform';

export interface VaultSecretSummary {
  name: string;
  /** personal: user.* keys the principal or an agent captured. platform: keys Curia reads
   *  directly at boot (read-only here). system: everything else, declared or orphaned. */
  kind: VaultSecretKind;
  /** Set in the vault. An environment fallback does not count. */
  configured: boolean;
  /** Some ENABLED declarer requires it. Each declarer's own `required` stays in declaredBy,
   *  so the page can say "required by Slack (disabled)" without flagging it as missing. */
  required: boolean;
  /** Name of the environment variable supplying the value while the vault has none, else
   *  null. Name only — never the value. Remove does not clear it. */
  envFallback: string | null;
  declaredBy: VaultSecretDeclarer[];
  /** null when the secret is not in the vault. */
  valueFormat: 'string' | 'json' | null;
  /** ISO timestamps; null when not in the vault. */
  createdAt: string | null;
  updatedAt: string | null;
  /** Latest recorded read by Curia; null when never read or no usage source is wired. */
  lastUsedAt: string | null;
  /** Read once when Curia starts, so individual reads are not recorded. */
  readAtStartup: boolean;
  /** Personal rows only: non-secret sign-in details. */
  loginUrl?: string;
  username?: string;
}

/** Generous ceiling for a string secret (API keys, tokens). Structured/JSON secrets use
 *  a different storage path; this endpoint only sets 'string' secrets a skill declares. */
const MAX_SECRET_VALUE_LENGTH = 8192;

const PLATFORM_KEY_REFUSAL = 'Managed by deployment — change it in the deploy environment, not here.';

/** A JSON-valued secret was captured by Curia with structure the console can't edit. */
function structuredValueRefusal(name: string): string {
  return `'${name}' holds a structured value. Recapture through Curia to change a structured value.`;
}

/** The value a write would store, or the 400 message when it is unusable: it must be a string
 *  with something other than whitespace in it, at most MAX_SECRET_VALUE_LENGTH characters. */
function checkValue(value: unknown): { value: string } | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: 'Body must include a non-empty string "value".' };
  }
  if (value.length > MAX_SECRET_VALUE_LENGTH) {
    return { error: `Secret value exceeds ${MAX_SECRET_VALUE_LENGTH} characters.` };
  }
  return { value };
}

/** One sign-in detail field of a PATCH: undefined when absent (keep), null when '' or null
 *  (clear), otherwise the validated value. Throws with a message fit for a 400. */
function detailPatchField(field: 'loginUrl' | 'username', raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const parsed = field === 'loginUrl'
    ? parseUserSecretDetails({ login_url: raw }).loginUrl
    : parseUserSecretDetails({ username: raw }).username;
  // parseUserSecretDetails returns a non-blank field or throws, so this is unreachable.
  if (parsed === undefined) throw new Error(`${field} is not valid`);
  return parsed;
}

const DEFAULT_USES_LIMIT = 5;
const MAX_USES_LIMIT = 20;

/** ?limit for the recent-uses route: default 5, clamped to 1..20. */
function usesLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_USES_LIMIT;
  return Math.min(MAX_USES_LIMIT, Math.max(1, n));
}

/** The console's naming fields for a personal secret (see consoleSecretNameInput). */
type NamingBody = { type?: unknown; label?: unknown; loginUrl?: unknown };

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
  /** Optional: when present, a delete is refused while an enabled email account needs its grant. */
  emailAccounts?: Pick<EmailAccountsRepo, 'list'>;
  /** Optional: last-read times for the Secrets page. When absent, lastUsedAt is null. */
  usage?: SecretUsagePort;
  /** Every set and delete is published here as a secret.changed audit event (#2453). */
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

  // Two-stage audit for a set or delete (#2453), published as secret.changed — key name only,
  // never a value. `requested` goes out BEFORE the vault is touched; if it can't be written
  // the change is refused (this sends the 500 itself and returns false). `completed` follows
  // a successful write. A vault write that throws is NOT recorded as failed: the statement may
  // have committed before the connection dropped, so a `requested` with no `completed` means
  // the change did not happen or its outcome is unknown, never that it happened.
  type SecretChange = {
    name: string;
    action: 'set' | 'delete' | 'details';
    force?: boolean;
    affected?: { kind: string; name: string }[];
  };

  function changePayload(request: FastifyRequest, change: SecretChange, stage: 'requested' | 'completed') {
    return createSecretChanged({
      secretName: change.name,
      action: change.action,
      stage,
      ...actorFromRequest(request, sessions),
      force: change.force,
      affected: change.affected,
    });
  }

  async function auditRequested(request: FastifyRequest, reply: FastifyReply, change: SecretChange): Promise<boolean> {
    try {
      await options.bus.publish('system', changePayload(request, change, 'requested'));
      return true;
    } catch (err) {
      request.log.error({ err, name: change.name, action: change.action }, 'vault change audit write failed — change refused');
      void reply.status(500).send({
        error: 'Nothing was changed: the change could not be audited, so it was not made. Check the server logs.',
      });
      return false;
    }
  }

  // The change has already been made, so a miss here is logged rather than turned into an
  // error that would invite retrying a change that happened.
  async function auditCompleted(request: FastifyRequest, change: SecretChange): Promise<void> {
    try {
      await options.bus.publish('system', changePayload(request, change, 'completed'));
    } catch (err) {
      request.log.error({ err, name: change.name, action: change.action }, 'vault change outcome audit write failed');
    }
  }

  // Platform keys are a deployment concern: every write route refuses them first, before the
  // allowlist and before any audit. Sends the 403 itself and returns true when it refused.
  function refusePlatformKey(request: FastifyRequest, reply: FastifyReply, name: string): boolean {
    if (!isPlatformVaultKey(name)) return false;
    request.log.info({ name }, 'vault change rejected: platform key');
    void reply.status(403).send({ error: PLATFORM_KEY_REFUSAL });
    return true;
  }

  async function metadataFor(name: string): Promise<SecretMetadata | undefined> {
    return (await secretsService.listMetadata()).find(m => m.name === name);
  }

  // The user.* key a console create names: the site for a website login, the user's label
  // otherwise, reusing an existing key with the same identity (resolveUserSecretName).
  // Bad naming input comes back as { error } for a 400. Only the fact that naming failed is
  // logged — never the input or the thrown message, since a URL may carry userinfo.
  async function resolveConsoleName(request: FastifyRequest, body: NamingBody | undefined): Promise<{ name: string } | { error: string }> {
    const type = body?.type;
    if (type !== 'website_login' && type !== 'other') {
      return { error: '"type" must be "website_login" or "other".' };
    }
    const label = body?.label ?? undefined;
    const loginUrl = body?.loginUrl ?? undefined;
    if ((label !== undefined && typeof label !== 'string') || (loginUrl !== undefined && typeof loginUrl !== 'string')) {
      return { error: '"label" and "loginUrl" must be strings.' };
    }
    const namingFailed = (err: unknown) => {
      request.log.info('vault personal secret naming rejected');
      return { error: err instanceof Error ? err.message : 'The secret could not be named.' };
    };

    let input: string;
    try {
      input = consoleSecretNameInput({ type, label, loginUrl });
    } catch (err) {
      return namingFailed(err);
    }
    const existing = await secretsService.listUserNames();
    let name: string;
    try {
      name = resolveUserSecretName(input, existing);
    } catch (err) {
      return namingFailed(err);
    }
    // resolveUserSecretName only ever emits user.* names; this keeps the sandbox explicit.
    if (!name.startsWith(USER_SECRET_PREFIX)) throw new Error('personal secret name escaped the user.* prefix');
    return { name };
  }

  // Every declaration of a vault key across tools, MCP servers, channels, email accounts and
  // the principal mailbox. Reads in-memory discovery plus enabled state from the registry rows only —
  // never the registries' list() views, which decrypt every declared credential to report
  // whether it is set.
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
      const enabledServers = await options.mcpRegistryService.enabledServerNames();
      for (const d of options.mcpRegistryService.secretDeclarations()) {
        add(d.key, { kind: 'mcp', name: d.server, required: d.required, enabled: enabledServers.has(d.server) });
      }
    }

    const enabledChannels = options.channelRegistryService
      ? await options.channelRegistryService.enabledChannelNames()
      : new Set<string>();
    for (const descriptor of CHANNEL_CATALOG) {
      for (const field of descriptor.credentialFields) {
        add(`channel.${descriptor.name}.${field.key}`, {
          kind: 'channel',
          name: descriptor.name,
          required: descriptor.requiredSecretKeys.includes(field.key),
          // Always-on channels (http, cli) have no registry row.
          enabled: enabledChannels.has(descriptor.name) || !descriptor.isToggleable,
        });
      }
    }

    // The principal's Nylas grant is what calendar runs on (index.ts turns calendar off
    // without it) and what ceo-inbox and nylas-principal-mailbox read. The address only
    // filters reply-all CC.
    add('ceo_nylas_grant_id', { kind: 'principal-mailbox', name: 'Calendar and principal inbox', required: true, enabled: true });
    add('ceo_self_email', { kind: 'principal-mailbox', name: 'Principal inbox', required: false, enabled: true });

    // Each email account boots from its own grant (resolve-email-accounts.ts skips an enabled
    // account that has none), so an enabled account requires it.
    if (options.emailAccounts) {
      for (const acct of await options.emailAccounts.list()) {
        add(emailAccountGrantSecretName(acct.name), { kind: 'email-account', name: acct.name, required: true, enabled: acct.enabled });
      }
    }
    return out;
  }

  // The environment variable standing in for a vault key, if one is set. Tool secrets fall
  // back to the upper-cased key name (execution.ts); channel credentials to the catalog's
  // envFallback. Name only — the value is never read into a response.
  function envFallbackFor(name: string, declaredBy: VaultSecretDeclarer[]): string | null {
    const candidates: string[] = [];
    if (declaredBy.some(d => d.kind === 'tool')) candidates.push(name.toUpperCase());
    for (const descriptor of CHANNEL_CATALOG) {
      for (const field of descriptor.credentialFields) {
        if (field.envFallback && name === `channel.${descriptor.name}.${field.key}`) candidates.push(field.envFallback);
      }
    }
    return candidates.find(v => !!process.env[v]) ?? null;
  }

  // -- GET /api/vault/secrets — every vault secret plus declared-but-unset ones (no values) --
  // Each vault name lands in exactly one row; the first matching rule wins:
  //   1. platform key in the vault -> platform (real declarations plus a platform declarer)
  //   2. user.*                    -> personal (sign-in details from user_secret_details)
  //   3. declared                  -> system (also covers declared names not in the vault)
  //   4. anything else in the vault -> system orphan, declaredBy: []
  app.get('/api/vault/secrets', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const metadata = new Map((await secretsService.listMetadata()).map(m => [m.name, m]));
      const declarations = await collectDeclarations();
      const userDetails = await secretsService.listUserDetails();
      const lastUsed = options.usage ? await options.usage.lastUsedByName() : new Map<string, Date>();

      const row = (name: string, kind: VaultSecretKind, declaredBy: VaultSecretDeclarer[]): VaultSecretSummary => {
        const meta = metadata.get(name);
        const details = kind === 'personal' ? userDetails.get(name) : undefined;
        return {
          name,
          kind,
          configured: meta !== undefined,
          required: kind === 'platform' || declaredBy.some(d => d.required && d.enabled),
          envFallback: meta ? null : envFallbackFor(name, declaredBy),
          declaredBy,
          valueFormat: meta?.valueFormat ?? null,
          createdAt: meta?.createdAt.toISOString() ?? null,
          updatedAt: meta?.updatedAt.toISOString() ?? null,
          lastUsedAt: lastUsed.get(name)?.toISOString() ?? null,
          readAtStartup: kind === 'platform' ||
            (kind === 'system' && declaredBy.length > 0 && !declaredBy.some(d => d.kind === 'tool')),
          ...(details?.loginUrl ? { loginUrl: details.loginUrl } : {}),
          ...(details?.username ? { username: details.username } : {}),
        };
      };

      const secrets: VaultSecretSummary[] = [];
      for (const name of metadata.keys()) {
        const declared = declarations.get(name) ?? [];
        if (isPlatformVaultKey(name)) {
          secrets.push(row(name, 'platform', [
            ...declared,
            { kind: 'platform', name: platformKeyLabel(name) ?? name, required: true, enabled: true },
          ]));
        } else if (name.startsWith('user.')) {
          secrets.push(row(name, 'personal', []));
        } else {
          secrets.push(row(name, 'system', declared));
        }
      }
      // Declared but not in the vault: still listed so the page can say what is missing.
      for (const [name, declaredBy] of declarations) {
        if (!metadata.has(name)) secrets.push(row(name, 'system', declaredBy));
      }
      secrets.sort((a, b) => a.name.localeCompare(b.name));
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
    if (refusePlatformKey(request, reply, name)) return;
    // A secret value must be a non-blank string, so the gate can't be satisfied by storing
    // a blank — a present-but-empty key is not "configured". The upper bound is defense in
    // depth: the global bodyLimit already caps it, but these are API-key-shaped secrets.
    const checked = checkValue((request.body as { value?: unknown } | undefined)?.value);
    if ('error' in checked) return reply.status(400).send({ error: checked.error });
    const { value } = checked;

    // Scope guard — declared names only (isAllowedVaultName). DELETE also takes any stored name.
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
    const change: SecretChange = { name, action: 'set' };
    if (!await auditRequested(request, reply, change)) return;

    try {
      await secretsService.set(name, value);
      await auditCompleted(request, change);
      return reply.send({ ok: true });
    } catch (err) {
      // No outcome row: the write may have committed before it threw. Do NOT log the value — only the key name.
      request.log.error({ err, name }, 'vault set failed');
      return reply.status(500).send({ error: 'Failed to save secret. Check server logs.' });
    }
  });

  // -- DELETE /api/vault/secrets/:name — remove a declared, personal or orphaned secret (idempotent) --
  // Accepts an allowlisted name, or any name already in the vault (user.* keys and orphans);
  // a platform key is refused first. Refused with 409 while an enabled tool, MCP server,
  // channel or email account requires the key, naming what would stop working; the console
  // confirms and retries with ?force=true. Personal keys and orphans have no declarers, so the
  // 409 never fires for them. Deleting an allowlisted key that isn't set is a no-op: 200 with
  // removed:false.
  app.delete('/api/vault/secrets/:name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };
    if (refusePlatformKey(request, reply, name)) return;
    const force = (request.query as { force?: string } | undefined)?.force === 'true';

    try {
      if (!(await secretsService.list()).includes(name)) {
        if (!isAllowedVaultName(name, options)) {
          request.log.info({ name }, 'vault delete rejected: name not in the vault nor declared by any skill, MCP server, or channel');
          return reply.status(400).send({
            error: `'${name}' is not in the vault, nor a secret declared by any skill or MCP server, ` +
              `nor a known channel credential.`,
          });
        }
        return reply.send({ ok: true, removed: false });
      }

      const affected = ((await collectDeclarations()).get(name) ?? [])
        .filter(d => d.required && d.enabled);
      if (affected.length > 0 && !force) {
        // Tool secrets are re-read from the vault on every call; channel credentials, MCP
        // keys and the principal grant are read at boot, so they keep working until restart.
        const effect = (d: VaultSecretDeclarer) => d.kind === 'tool' ? 'on its next call' : 'after the next restart';
        return reply.status(409).send({
          error: `'${name}' is required by ${affected.map(d => `enabled ${d.kind === 'principal-mailbox' ? d.name : `${d.kind === 'email-account' ? 'email account' : d.kind} '${d.name}'`} (stops working ${effect(d)})`).join(', ')}. ` +
            `It will not work again until the secret is set.`,
          affected: affected.map(d => ({ kind: d.kind, name: d.name })),
        });
      }

      const change: SecretChange = {
        name,
        action: 'delete',
        ...(force ? { force: true, affected: affected.map(d => ({ kind: d.kind, name: d.name })) } : {}),
      };
      if (!await auditRequested(request, reply, change)) return;
      // A delete that throws gets no outcome row: it may have committed first.
      // A personal key's sign-in details go first, so a failure between the two can't leave
      // stale details for a later create of the same name to inherit.
      if (name.startsWith(USER_SECRET_PREFIX)) await secretsService.deleteUserDetails(name);
      await secretsService.delete(name);
      await auditCompleted(request, change);
      return reply.send({ ok: true, removed: true });
    } catch (err) {
      request.log.error({ err, name }, 'vault delete failed');
      return reply.status(500).send({ error: 'Failed to remove secret. Check server logs.' });
    }
  });

  // -- GET /api/vault/secrets/:name/uses — newest recorded reads of one secret (no values) --
  // "Used" means Curia read it (a secret.accessed audit row); whether a sign-in worked isn't
  // recorded. Empty when no usage source is wired.
  app.get('/api/vault/secrets/:name/uses', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };
    const limit = usesLimit((request.query as { limit?: unknown } | undefined)?.limit);
    if (!options.usage) return reply.send({ uses: [] });
    try {
      const uses = await options.usage.recentUses(name, limit);
      return reply.send({
        uses: uses.map(u => ({
          at: u.at.toISOString(),
          agentId: u.agentId,
          toolName: u.toolName,
          source: u.source,
          byReference: u.byReference,
        })),
      });
    } catch (err) {
      request.log.error({ err, name }, 'GET /api/vault/secrets/:name/uses failed');
      return reply.status(500).send({ error: 'Failed to read recent uses. Check server logs.' });
    }
  });

  // -- POST /api/vault/user-secrets/preview — the name a create would use (no writes, no audit) --
  // Body { type, label?, loginUrl? }. existing is set when that name is already in the vault,
  // so the console can warn that saving replaces it.
  app.post('/api/vault/user-secrets/preview', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const named = await resolveConsoleName(request, request.body as NamingBody | undefined);
      if ('error' in named) return reply.status(400).send({ error: named.error });
      const meta = await metadataFor(named.name);
      return reply.send({
        name: named.name,
        existing: meta ? { updatedAt: meta.updatedAt.toISOString(), valueFormat: meta.valueFormat } : null,
      });
    } catch (err) {
      request.log.error({ err }, 'POST /api/vault/user-secrets/preview failed');
      return reply.status(500).send({ error: 'Failed to preview the secret name. Check server logs.' });
    }
  });

  // -- POST /api/vault/user-secrets — create or replace a personal user.* secret --
  // Body { type, label?, loginUrl?, username?, value }. Named as in preview. Replacing keeps
  // the old sign-in details for any field left blank (upsertUserDetails). A JSON-valued key is
  // never overwritten from here: its structure came from a Curia capture.
  app.post('/api/vault/user-secrets', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = request.body as (NamingBody & { username?: unknown; value?: unknown }) | undefined;

    const checked = checkValue(body?.value);
    if ('error' in checked) return reply.status(400).send({ error: checked.error });

    let name: string | undefined;
    try {
      const named = await resolveConsoleName(request, body);
      if ('error' in named) return reply.status(400).send({ error: named.error });
      name = named.name;
      // After naming, so a bad login URL reports the same message as preview.
      let details: UserSecretDetails;
      try {
        details = parseUserSecretDetails({ login_url: body?.loginUrl, username: body?.username });
      } catch (err) {
        // Not the message: it can quote the URL.
        request.log.info('vault personal secret details rejected');
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid sign-in details.' });
      }
      const meta = await metadataFor(name);
      if (meta?.valueFormat === 'json') {
        return reply.status(409).send({ error: structuredValueRefusal(name) });
      }

      const change: SecretChange = { name, action: 'set' };
      if (!await auditRequested(request, reply, change)) return;
      await secretsService.set(name, checked.value);
      // No details given: write no row (an empty one would only bump updated_at).
      if (hasUserSecretDetails(details)) await secretsService.upsertUserDetails(name, details);
      await auditCompleted(request, change);
      return reply.send({ name, replaced: meta !== undefined });
    } catch (err) {
      // No outcome row: the write may have committed before it threw. Key name only.
      request.log.error({ err, name }, 'vault personal secret create failed');
      return reply.status(500).send({ error: 'Failed to save secret. Check server logs.' });
    }
  });

  // -- PATCH /api/vault/user-secrets/:name — edit a personal secret --
  // Body { loginUrl?, username?, value? }: an omitted field is kept, '' or null clears a detail.
  // Each kind of change present is audited on its own (set for the value, details for the
  // sign-in details), all requested before any write. A details-only edit never rewrites the value.
  app.patch('/api/vault/user-secrets/:name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };
    if (refusePlatformKey(request, reply, name)) return;
    if (!name.startsWith(USER_SECRET_PREFIX)) {
      return reply.status(400).send({ error: `'${name}' is not a personal secret. Only user.* secrets can be edited here.` });
    }
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as
      { value?: unknown; loginUrl?: unknown; username?: unknown };

    let value: string | undefined;
    if (body.value !== undefined) {
      const checked = checkValue(body.value);
      if ('error' in checked) return reply.status(400).send({ error: checked.error });
      value = checked.value;
    }

    const patch: UserSecretDetailsPatch = {};
    try {
      const loginUrl = detailPatchField('loginUrl', body.loginUrl);
      const username = detailPatchField('username', body.username);
      if (loginUrl !== undefined) patch.loginUrl = loginUrl;
      if (username !== undefined) patch.username = username;
    } catch (err) {
      // Not the message: it can quote the URL.
      request.log.info({ name }, 'vault personal secret details rejected');
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid sign-in details.' });
    }
    const hasDetails = patch.loginUrl !== undefined || patch.username !== undefined;
    if (value === undefined && !hasDetails) {
      return reply.status(400).send({ error: 'Body must include "value", "loginUrl" or "username".' });
    }

    try {
      const meta = await metadataFor(name);
      if (!meta) return reply.status(404).send({ error: `'${name}' no longer exists.` });
      if (value !== undefined && meta.valueFormat === 'json') {
        return reply.status(409).send({ error: structuredValueRefusal(name) });
      }

      const changes: SecretChange[] = [
        ...(value !== undefined ? [{ name, action: 'set' as const }] : []),
        ...(hasDetails ? [{ name, action: 'details' as const }] : []),
      ];
      for (const change of changes) {
        if (!await auditRequested(request, reply, change)) return;
      }
      // Each outcome row follows its own write, so a details failure doesn't drop the
      // completed row for a value that was set.
      if (value !== undefined) {
        await secretsService.set(name, value);
        await auditCompleted(request, { name, action: 'set' });
      }
      if (hasDetails) {
        await secretsService.patchUserDetails(name, patch);
        await auditCompleted(request, { name, action: 'details' });
      }
      return reply.send({ ok: true });
    } catch (err) {
      // No outcome row: the write may have committed before it threw. Key name only.
      request.log.error({ err, name }, 'vault personal secret edit failed');
      return reply.status(500).send({ error: 'Failed to save secret. Check server logs.' });
    }
  });
}
