// vault.test.ts — exercises the secrets-vault HTTP routes against fake services.
// Auth is satisfied via the x-web-bootstrap-secret header path of assertSecret (same
// pattern as channel-registry.test.ts); sessions is a real empty Map per SessionStore.
//
// The scope guard on PUT /api/vault/secrets/:name accepts a name only if it is EITHER a
// skill-declared secret OR a valid channel credential key from CHANNEL_CATALOG. These tests
// prove both accept paths and the reject paths (arbitrary names and bogus channel keys).
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { vaultRoutes, type VaultSecretsPort } from '../../../../../src/channels/http/routes/vault.js';
import type { RegistryService } from '../../../../../src/registry/registry-service.js';
import type { RegistryEntry } from '../../../../../src/registry/types.js';
import type { McpRegistryService } from '../../../../../src/registry/mcp-registry-service.js';
import type { ChannelRegistryService } from '../../../../../src/registry/channel-registry-service.js';
import type { EventBus } from '../../../../../src/bus/bus.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';
import type { UserSecretDetails } from '../../../../../src/secrets/user-secret-details.js';
import type { SecretUsagePort, SecretUse } from '../../../../../src/secrets/secret-usage-repo.js';
import { StaleCardEditError, type UserSecretDetailsPatch } from '../../../../../src/secrets/secrets-service.js';
import { CARD_VALIDATION_MESSAGES, type CreditCardPublicFields, type CreditCardSecretDoc, type StructuredSchemaTag } from '../../../../../src/secrets/structured-secret-schema.js';
import { serializeForLeakCheck } from '../../../../helpers/leak-check.js';

const BOOTSTRAP = 'test-bootstrap-secret';

// A skill-declared secret used to prove the original scope-guard path still works.
const DECLARED_SECRET = 'some_skill_secret';

/** Records set() calls so tests can assert the secret was actually written. */
interface RecordingSecrets extends VaultSecretsPort {
  sets: Array<{ name: string; value: string }>;
  deletes: string[];
  upserts: Array<{ name: string; details: UserSecretDetails }>;
  patches: Array<{ name: string; patch: UserSecretDetailsPatch }>;
  detailDeletes: string[];
  /** Every write in call order, e.g. 'details-delete:user.x', 'delete:user.x'. */
  order: string[];
  cardSets: Array<{ name: string; secret: CreditCardSecretDoc; publicFields: CreditCardPublicFields; label: string | null }>;
  cardPatches: Array<{ name: string; patch: { label?: string | null; publicFields?: CreditCardPublicFields } }>;
  cardRenewals: Array<{ name: string; change: { cvv: string; publicFields: CreditCardPublicFields } }>;
  cardReplaces: Array<{ name: string; change: { cvv: string } | { secret: CreditCardSecretDoc; publicFields: CreditCardPublicFields } }>;
  /** Anything that would decrypt a vault value. Listing a card must never call these. */
  decrypts: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  getJSON: ReturnType<typeof vi.fn>;
  getCardSecret: ReturnType<typeof vi.fn>;
}

const CREATED = new Date('2026-09-01T00:00:00.000Z');
const UPDATED = new Date('2026-10-02T00:00:00.000Z');

function fakeSecrets(
  preset: string[] = [],
  details: Record<string, UserSecretDetails> = {},
  formats: Record<string, 'string' | 'json'> = {},
): RecordingSecrets {
  const sets: Array<{ name: string; value: string }> = [];
  const deletes: string[] = [];
  const upserts: Array<{ name: string; details: UserSecretDetails }> = [];
  const patches: Array<{ name: string; patch: UserSecretDetailsPatch }> = [];
  const detailDeletes: string[] = [];
  const order: string[] = [];
  const cardSets: RecordingSecrets['cardSets'] = [];
  const cardPatches: RecordingSecrets['cardPatches'] = [];
  const cardReplaces: RecordingSecrets['cardReplaces'] = [];
  const cardRenewals: RecordingSecrets['cardRenewals'] = [];
  const decrypts = vi.fn(async () => { throw new Error('a decrypt was attempted'); });
  const present = new Set(preset);
  return {
    cardSets,
    cardPatches,
    cardReplaces,
    cardRenewals,
    renewCard: async (name: string, change: { cvv: string; publicFields: CreditCardPublicFields }) => { cardRenewals.push({ name, change }); },
    decrypts,
    get: decrypts,
    getJSON: decrypts,
    getCardSecret: decrypts,
    setCard: async (name: string, secret: CreditCardSecretDoc, publicFields: CreditCardPublicFields, label: string | null) => {
      cardSets.push({ name, secret, publicFields, label });
      present.add(name);
    },
    getStructuredSchema: async (name: string): Promise<StructuredSchemaTag | null> => details[name]?.schema ?? null,
    getCardPublic: async (name: string) => {
      const d = details[name];
      return d?.schema === 'credit_card' && d.publicFields ? { label: d.label ?? null, publicFields: d.publicFields } : null;
    },
    patchCardPublic: async (name: string, patch: { label?: string | null; publicFields?: CreditCardPublicFields }) => { cardPatches.push({ name, patch }); },
    replaceCardSecret: async (name: string, change: { cvv: string } | { secret: CreditCardSecretDoc; publicFields: CreditCardPublicFields }) => { cardReplaces.push({ name, change }); },
    sets,
    deletes,
    upserts,
    patches,
    detailDeletes,
    order,
    list: async () => [...present],
    listMetadata: async () => [...present].map(name => ({ name, valueFormat: formats[name] ?? 'string', createdAt: CREATED, updatedAt: UPDATED })),
    listUserNames: async () => [...present].filter(n => n.startsWith('user.')),
    listUserDetails: async () => new Map(Object.entries(details)),
    upsertUserDetails: async (name: string, d: UserSecretDetails) => { upserts.push({ name, details: d }); },
    patchUserDetails: async (name: string, patch: UserSecretDetailsPatch) => { patches.push({ name, patch }); },
    deleteUserDetails: async (name: string) => { detailDeletes.push(name); order.push(`details-delete:${name}`); },
    set: async (name: string, value: string) => {
      sets.push({ name, value });
      present.add(name);
    },
    delete: async (name: string) => {
      deletes.push(name);
      order.push(`delete:${name}`);
      present.delete(name);
    },
    // Mirror SecretsService: one call for value and details, refusing JSON and (edit) a missing key.
    setUserSecret: async (name: string, value: string, d: UserSecretDetails) => {
      if (formats[name] === 'json') return { outcome: 'structured' as const };
      const replaced = present.has(name);
      sets.push({ name, value });
      present.add(name);
      if (d.loginUrl !== undefined || d.username !== undefined) upserts.push({ name, details: d });
      return { outcome: 'written' as const, replaced };
    },
    editUserSecret: async (name: string, edit: { value?: string; details?: UserSecretDetailsPatch }) => {
      if (!present.has(name)) return { outcome: 'missing' as const };
      if (edit.value !== undefined && formats[name] === 'json') return { outcome: 'structured' as const };
      if (edit.value !== undefined) sets.push({ name, value: edit.value });
      if (edit.details) patches.push({ name, patch: edit.details });
      return { outcome: 'written' as const, replaced: true };
    },
  };
}

/** Collects published audit events; `fail` makes publish reject (audit write failure). */
function fakeBus(fail = false) {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const bus = {
    publish: vi.fn(async (_layer: string, event: { type: string; payload: Record<string, unknown> }) => {
      if (fail) throw new Error('audit down');
      published.push(event);
    }),
  } as unknown as EventBus;
  return { bus, published };
}

function toolEntry(name: string, state: RegistryEntry['state'], requires: string[], optional: string[] = []): RegistryEntry {
  return {
    name, kind: 'tool', state, installedAt: null, installedBy: null, enabledAt: null, enabledBy: null,
    metadata: {
      name, description: 'd', version: '1.0.0', requiresSecrets: requires,
      optionalSecrets: optional.map(n => ({ name: n, purpose: 'adds a thing' })),
    },
  };
}

// Minimal RegistryService fake — only declaredSecretNames() is called by these routes.
function fakeRegistry(declared: string[] = [DECLARED_SECRET], tools: RegistryEntry[] = []): RegistryService {
  const base: Partial<RegistryService> = {
    declaredSecretNames: () => declared,
    list: async () => tools,
  };
  return base as RegistryService;
}

async function build(
  secretsService: VaultSecretsPort,
  registryService: RegistryService,
  extra: { usage?: SecretUsagePort; bus?: EventBus; mcp?: McpRegistryService; channels?: ChannelRegistryService; emailAccounts?: Array<{ name: string; enabled: boolean }>; principalFallbackActive?: () => Promise<boolean>; livePrincipalMailboxIds?: () => Promise<string[]> } = {},
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(vaultRoutes, {
    secretsService,
    registryService,
    usage: extra.usage,
    mcpRegistryService: extra.mcp,
    channelRegistryService: extra.channels,
    emailAccounts: extra.emailAccounts
      ? { list: async () => extra.emailAccounts!.map(a => ({ ...a, selfEmail: `${a.name}@example.com`, provider: 'nylas', createdAt: new Date(), createdBy: 'test', updatedAt: new Date() })) }
      : undefined,
    principalFallbackActive: extra.principalFallbackActive,
    livePrincipalMailboxIds: extra.livePrincipalMailboxIds,
    bus: extra.bus ?? fakeBus().bus,
    webAppBootstrapSecret: BOOTSTRAP,
    sessions: new Map(),
  });
  return app;
}

const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

function put(app: FastifyInstance, name: string, body: unknown) {
  return app.inject({
    method: 'PUT',
    url: `/api/vault/secrets/${name}`,
    headers: auth,
    payload: body as object,
  });
}

function del(app: FastifyInstance, name: string, query = '') {
  return app.inject({ method: 'DELETE', url: `/api/vault/secrets/${name}${query}`, headers: auth });
}

describe('vault routes', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('accepts a valid channel credential key and writes it', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'channel.email.nylas_api_key', { value: 'nk_live_abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(secrets.sets).toEqual([{ name: 'channel.email.nylas_api_key', value: 'nk_live_abc' }]);
  });

  it('accepts a skill-declared secret (existing behavior preserved)', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry([DECLARED_SECRET]));
    const res = await put(app, DECLARED_SECRET, { value: 'shhh' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(secrets.sets).toEqual([{ name: DECLARED_SECRET, value: 'shhh' }]);
  });

  it('rejects an arbitrary undeclared name with 400', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'random_key', { value: 'x' });
    expect(res.statusCode).toBe(400);
    expect(secrets.sets).toEqual([]);
  });

  it('rejects a bogus channel key not in the catalog with 400', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'channel.email.not_a_field', { value: 'x' });
    expect(res.statusCode).toBe(400);
    expect(secrets.sets).toEqual([]);
  });

  it('rejects a channel credential key for a channel with no fields with 400', async () => {
    // 'telegram' is not a channel at all; proves we don't accept arbitrary channel.* names.
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'channel.telegram.x', { value: 'x' });
    expect(res.statusCode).toBe(400);
    expect(secrets.sets).toEqual([]);
  });

  it('rejects an empty value with 400 even for a valid channel key', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'channel.email.nylas_api_key', { value: '' });
    expect(res.statusCode).toBe(400);
    expect(secrets.sets).toEqual([]);
  });

  it('rejects a whitespace-only value with 400', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, DECLARED_SECRET, { value: '  \n ' });
    expect(res.statusCode).toBe(400);
    expect(secrets.sets).toEqual([]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await app.inject({
      method: 'PUT',
      url: '/api/vault/secrets/channel.email.nylas_api_key',
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(401);
    expect(secrets.sets).toEqual([]);
  });

  // --- per-account email grant key tests (#1101) ---

  it('accepts a per-account email grant key', async () => {
    // channel.email.<name>.nylas_grant_id is the per-account grant pattern added
    // by the email-accounts console flow; it must be writable here.
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'channel.email.curia.nylas_grant_id', { value: 'grant_abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(secrets.sets).toEqual([{ name: 'channel.email.curia.nylas_grant_id', value: 'grant_abc' }]);
  });

  it('still rejects an undeclared, non-credential key', async () => {
    // Widening the guard to accept per-account grant keys must not open the door
    // to arbitrary undeclared names.
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'random_key', { value: 'x' });
    expect(res.statusCode).toBe(400);
    expect(secrets.sets).toEqual([]);
  });

  it('rejects a per-account key for a non-grant field', async () => {
    // channel.email.<name>.nylas_api_key is not the per-account grant pattern;
    // only nylas_grant_id is written per-account. This must stay rejected.
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'channel.email.curia.nylas_api_key', { value: 'nk_live_abc' });
    expect(res.statusCode).toBe(400);
    expect(secrets.sets).toEqual([]);
  });

  // --- principal mailbox keys (#2409) ---

  it.each([
    ['ceo_nylas_grant_id', 'grant-v'],
    ['ceo_self_email', 'principal@example.com'],
  ])('accepts the principal-mailbox key %s while the deferred fallback is active', async (name, value) => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry(), { principalFallbackActive: async () => true });
    const res = await put(app, name, { value });
    expect(res.statusCode).toBe(200);
    expect(secrets.sets).toEqual([{ name, value }]);
  });

  // The deferred migration registers this address; a non-address would register nothing.
  it.each(['not-an-address', 'a@b', 'two words@example.com'])('rejects ceo_self_email %j', async value => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry(), { principalFallbackActive: async () => true });
    const res = await put(app, 'ceo_self_email', { value });
    expect(res.statusCode).toBe(400);
    expect(secrets.sets).toEqual([]);
  });

  it('no longer accepts the flat email grant and address no adapter reads', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    for (const name of ['channel.email.nylas_grant_id', 'channel.email.nylas_self_email']) {
      const res = await put(app, name, { value: 'v' });
      expect(res.statusCode, name).toBe(400);
    }
    expect(secrets.sets).toEqual([]);
  });

  // --- delete + audit + list (#2453) ---

  it('PUT and DELETE reject the same unknown names when they are not in the vault', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    for (const name of ['random_key', 'channel.email.not_a_field', 'channel.email.curia.nylas_api_key']) {
      expect((await put(app, name, { value: 'x' })).statusCode, `PUT ${name}`).toBe(400);
      expect((await del(app, name)).statusCode, `DELETE ${name}`).toBe(400);
    }
    expect(secrets.sets).toEqual([]);
    expect(secrets.deletes).toEqual([]);
  });

  it('DELETE removes an allowlisted secret and repeating it is idempotent', async () => {
    const secrets = fakeSecrets([DECLARED_SECRET]);
    app = await build(secrets, fakeRegistry());
    const first = await del(app, DECLARED_SECRET);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, removed: true });
    const second = await del(app, DECLARED_SECRET);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, removed: false });
    expect(secrets.deletes).toEqual([DECLARED_SECRET]);
  });

  it('DELETE without auth returns 401 and removes nothing', async () => {
    const secrets = fakeSecrets([DECLARED_SECRET]);
    app = await build(secrets, fakeRegistry());
    const res = await app.inject({ method: 'DELETE', url: `/api/vault/secrets/${DECLARED_SECRET}` });
    expect(res.statusCode).toBe(401);
    expect(secrets.deletes).toEqual([]);
  });

  it('refuses to delete a secret an enabled tool requires, naming the tool, unless forced', async () => {
    const secrets = fakeSecrets(['k']);
    app = await build(secrets, fakeRegistry(['k'], [toolEntry('needs-k', 'enabled', ['k'])]));
    const refused = await del(app, 'k');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("tool 'needs-k'");
    expect(refused.json().affected).toEqual([{ kind: 'tool', name: 'needs-k' }]);
    expect(secrets.deletes).toEqual([]);

    const forced = await del(app, 'k', '?force=true');
    expect(forced.statusCode).toBe(200);
    expect(secrets.deletes).toEqual(['k']);
  });

  it('deletes freely when only a disabled tool requires it or the tool treats it as optional', async () => {
    const secrets = fakeSecrets(['req', 'opt']);
    app = await build(secrets, fakeRegistry(['req', 'opt'], [
      toolEntry('off', 'installed', ['req']),
      toolEntry('on', 'enabled', [], ['opt']),
    ]));
    expect((await del(app, 'req')).statusCode).toBe(200);
    expect((await del(app, 'opt')).statusCode).toBe(200);
  });

  it('refuses to delete a credential an enabled channel requires', async () => {
    const secrets = fakeSecrets(['channel.slack.bot_token']);
    const channels = { enabledChannelNames: async () => new Set(['slack']) } as unknown as ChannelRegistryService;
    app = await build(secrets, fakeRegistry(), { channels });
    const res = await del(app, 'channel.slack.bot_token');
    expect(res.statusCode).toBe(409);
    expect(res.json().affected).toEqual([{ kind: 'channel', name: 'slack' }]);
    // Channel credentials are read at boot, so the message says when it bites.
    expect(res.json().error).toContain('after the next restart');
  });

  it('says a tool secret stops working on its next call', async () => {
    const secrets = fakeSecrets(['k']);
    app = await build(secrets, fakeRegistry(['k'], [toolEntry('needs-k', 'enabled', ['k'])]));
    expect((await del(app, 'k')).json().error).toContain('on its next call');
  });

  it('allows deleting the flat principal keys now that nothing declares them (#2475)', async () => {
    const secrets = fakeSecrets(['ceo_nylas_grant_id', 'ceo_self_email']);
    app = await build(secrets, fakeRegistry());
    expect((await del(app, 'ceo_nylas_grant_id')).statusCode).toBe(200);
    expect((await del(app, 'ceo_self_email')).statusCode).toBe(200);
  });

  it('refuses to delete the flat grant while the deferred-migration fallback is active (#2475)', async () => {
    const secrets = fakeSecrets(['ceo_nylas_grant_id']);
    app = await build(secrets, fakeRegistry(), { principalFallbackActive: async () => true });
    const refused = await del(app, 'ceo_nylas_grant_id');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('Calendar and principal inbox');
  });

  it.each([
    ['no fallback dependency', {}],
    ['the fallback inactive', { principalFallbackActive: async () => false }],
  ] as const)('vault refuses writes to the flat keys (%s) (#2475, Task 33b)', async (_label, extra) => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry(), extra);
    for (const name of ['ceo_nylas_grant_id', 'ceo_self_email']) {
      const value = name === 'ceo_self_email' ? 'pat@example.com' : 'g';
      const setRes = await put(app, name, { value });
      expect(setRes.statusCode, name).toBe(409);
      expect(setRes.json().error).toContain('retired');
      expect(setRes.json().error).toContain('Settings → Personality → Email & Calendar');
    }
    expect(secrets.sets).toEqual([]);
  });

  it('still lets the Secrets page delete a stray flat key (#2475, Task 33b)', async () => {
    const secrets = fakeSecrets(['ceo_nylas_grant_id', 'ceo_self_email']);
    app = await build(secrets, fakeRegistry(), { principalFallbackActive: async () => false });
    expect((await del(app, 'ceo_nylas_grant_id')).statusCode).toBe(200);
    expect((await del(app, 'ceo_self_email')).statusCode).toBe(200);
    expect(secrets.deletes).toEqual(['ceo_nylas_grant_id', 'ceo_self_email']);
  });

  it('still allows PUT of the flat grant while the deferred fallback is active (#2475)', async () => {
    const secrets = fakeSecrets(['ceo_nylas_grant_id']);
    app = await build(secrets, fakeRegistry(), {
      principalFallbackActive: async () => true,
    });
    expect((await put(app, 'ceo_nylas_grant_id', { value: 'g2' })).statusCode).toBe(200);
    expect((await del(app, 'ceo_nylas_grant_id')).statusCode).toBe(409);
  });

  it('refuses a direct PUT of a per-mailbox grant, which only the console validates (#2475)', async () => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, 'principal.mailbox.work.nylas_grant_id', { value: 'g' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Settings → Personality → Email & Calendar');
    expect(secrets.sets).toEqual([]);
    expect((await put(app, 'principal.mailbox.Work.nylas_grant_id', { value: 'g' })).statusCode).toBe(400);
    expect((await put(app, 'principal.mailbox.work.other', { value: 'g' })).statusCode).toBe(400);
  });

  it('still lets the Secrets page clear a removed mailbox\'s grant (#2475)', async () => {
    const secrets = fakeSecrets(['principal.mailbox.work.nylas_grant_id']);
    app = await build(secrets, fakeRegistry(), { livePrincipalMailboxIds: async () => ['personal'] });
    expect((await del(app, 'principal.mailbox.work.nylas_grant_id')).statusCode).toBe(200);
    expect(secrets.deletes).toEqual(['principal.mailbox.work.nylas_grant_id']);
  });

  it('refuses to delete a live mailbox\'s grant, even with force (silent-failure 4)', async () => {
    const secrets = fakeSecrets(['principal.mailbox.work.nylas_grant_id']);
    app = await build(secrets, fakeRegistry(), { livePrincipalMailboxIds: async () => ['work'] });
    for (const name of ['principal.mailbox.work.nylas_grant_id', 'principal.mailbox.work.nylas_grant_id?force=true']) {
      const res = await app.inject({ method: 'DELETE', url: `/api/vault/secrets/${name}`, headers: auth });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('Remove the mailbox');
    }
    expect(secrets.deletes).toEqual([]);
  });

  it('audits set and delete in two stages by key name with no value', async () => {
    const { bus, published } = fakeBus();
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry(), { bus });
    await put(app, DECLARED_SECRET, { value: 'super-secret-value' });
    await del(app, DECLARED_SECRET);
    expect(published.map(e => e.type)).toEqual(['secret.changed', 'secret.changed', 'secret.changed', 'secret.changed']);
    expect(published.map(e => [e.payload['action'], e.payload['stage'], e.payload['secretName']])).toEqual([
      ['set', 'requested', DECLARED_SECRET],
      ['set', 'completed', DECLARED_SECRET],
      ['delete', 'requested', DECLARED_SECRET],
      ['delete', 'completed', DECLARED_SECRET],
    ]);
    expect(JSON.stringify(published)).not.toContain('super-secret-value');
  });

  // A write that throws may have committed, so it gets no outcome row at all: `requested`
  // alone reads as "not done or unknown", never as a confirmed failure.
  it('records no outcome when the vault write throws', async () => {
    const { bus, published } = fakeBus();
    const secrets = fakeSecrets([DECLARED_SECRET]);
    secrets.set = async () => { throw new Error('db down'); };
    secrets.delete = async () => { throw new Error('db down'); };
    app = await build(secrets, fakeRegistry(), { bus });
    expect((await put(app, DECLARED_SECRET, { value: 'v' })).statusCode).toBe(500);
    expect((await del(app, DECLARED_SECRET)).statusCode).toBe(500);
    expect(published.map(e => `${e.payload['action']}:${e.payload['stage']}`)).toEqual([
      'set:requested', 'delete:requested',
    ]);
  });

  it('records force and the affected components on a forced delete', async () => {
    const { bus, published } = fakeBus();
    const secrets = fakeSecrets(['k']);
    app = await build(secrets, fakeRegistry(['k'], [toolEntry('needs-k', 'enabled', ['k'])]), { bus });
    await del(app, 'k', '?force=true');
    expect(published.map(e => e.payload)).toEqual([
      { secretName: 'k', action: 'delete', stage: 'requested', initiatedBy: 'bootstrap_secret', force: true, affected: [{ kind: 'tool', name: 'needs-k' }] },
      { secretName: 'k', action: 'delete', stage: 'completed', initiatedBy: 'bootstrap_secret', force: true, affected: [{ kind: 'tool', name: 'needs-k' }] },
    ]);
  });

  it('records the console session as the actor when a session cookie authenticated the change', async () => {
    const { bus, published } = fakeBus();
    const sessions = new Map([[hashToken('tok'), { id: 'sess-1', expiresAt: Date.now() + 60_000, renewedAt: Date.now() }]]);
    app = Fastify();
    await app.register(cookie);
    await app.register(vaultRoutes, { secretsService: fakeSecrets(), registryService: fakeRegistry(), bus, webAppBootstrapSecret: BOOTSTRAP, sessions });
    const res = await app.inject({ method: 'PUT', url: `/api/vault/secrets/${DECLARED_SECRET}`, cookies: { curia_session: 'tok' }, payload: { value: 'v' } });
    expect(res.statusCode).toBe(200);
    expect(published.map(e => [e.payload['initiatedBy'], e.payload['actorSessionId']])).toEqual([
      ['session', 'sess-1'], ['session', 'sess-1'],
    ]);
  });

  it("refuses to delete an enabled email account's grant without force", async () => {
    const grant = 'channel.email.work.nylas_grant_id';
    const secrets = fakeSecrets([grant, 'channel.email.old.nylas_grant_id']);
    app = await build(secrets, fakeRegistry(), { emailAccounts: [{ name: 'work', enabled: true }, { name: 'old', enabled: false }] });
    const refused = await del(app, grant);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("email account 'work' (stops working after the next restart)");
    expect(refused.json().affected).toEqual([{ kind: 'email-account', name: 'work' }]);
    expect(secrets.deletes).toEqual([]);
    // A disabled account does not block, and force goes through.
    expect((await del(app, 'channel.email.old.nylas_grant_id')).statusCode).toBe(200);
    expect((await del(app, grant, '?force=true')).statusCode).toBe(200);
    expect(secrets.deletes).toEqual(['channel.email.old.nylas_grant_id', grant]);
  });

  it('refuses a set or delete when the audit row cannot be written', async () => {
    const secrets = fakeSecrets([DECLARED_SECRET]);
    app = await build(secrets, fakeRegistry(), { bus: fakeBus(true).bus });
    expect((await put(app, DECLARED_SECRET, { value: 'v' })).statusCode).toBe(500);
    expect((await del(app, DECLARED_SECRET)).statusCode).toBe(500);
    expect(secrets.sets).toEqual([]);
    expect(secrets.deletes).toEqual([]);
  });

  it('does not count a disabled declarer as making a secret required', async () => {
    // Slack is not enabled (no registry): its credentials are declared but not "missing".
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry(['k'], [toolEntry('off', 'installed', ['k'])]));
    const res = await app.inject({ method: 'GET', url: '/api/vault/secrets', headers: auth });
    const byName = new Map((res.json().secrets as Array<{ name: string; required: boolean; declaredBy: Array<{ required: boolean; enabled: boolean }> }>).map(x => [x.name, x]));
    expect(byName.get('k')).toMatchObject({ required: false, declaredBy: [{ required: true, enabled: false }] });
    expect(byName.get('channel.slack.bot_token')).toMatchObject({ required: false, declaredBy: [{ required: true, enabled: false }] });
  });

  it('reports the environment variable supplying a value, by name only', async () => {
    process.env['VAULT_TEST_FALLBACK_KEY'] = 'env-secret-value';
    try {
      app = await build(fakeSecrets(), fakeRegistry(['vault_test_fallback_key'], [toolEntry('t', 'enabled', [], ['vault_test_fallback_key'])]));
      const res = await app.inject({ method: 'GET', url: '/api/vault/secrets', headers: auth });
      const row = (res.json().secrets as Array<{ name: string; envFallback: string | null }>).find(x => x.name === 'vault_test_fallback_key');
      expect(row?.envFallback).toBe('VAULT_TEST_FALLBACK_KEY');
      expect(res.body).not.toContain('env-secret-value');
    } finally {
      delete process.env['VAULT_TEST_FALLBACK_KEY'];
    }
  });

  it('lists allowlisted secrets with status and declarers, never values', async () => {
    const secrets = fakeSecrets(['k', 'channel.email.curia.nylas_grant_id']);
    app = await build(secrets, fakeRegistry(['k'], [toolEntry('needs-k', 'enabled', ['k'], ['opt'])]));
    const res = await app.inject({ method: 'GET', url: '/api/vault/secrets', headers: auth });
    expect(res.statusCode).toBe(200);
    const list = res.json().secrets as Array<{ name: string; configured: boolean; required: boolean; declaredBy: Array<{ kind: string; name: string }> }>;
    const byName = new Map(list.map(s => [s.name, s]));
    expect(byName.get('k')).toMatchObject({ configured: true, required: true, declaredBy: [{ kind: 'tool', name: 'needs-k' }] });
    expect(byName.get('opt')).toMatchObject({ configured: false, required: false });
    expect(byName.get('channel.slack.bot_token')).toMatchObject({ configured: false, required: false });
    // The flat principal keys are no longer declared on the Secrets page (#2475).
    expect(byName.has('ceo_self_email')).toBe(false);
    expect(byName.has('ceo_nylas_grant_id')).toBe(false);
    // No email_accounts row for 'curia': an orphan, listed as a system row with no declarers.
    expect(byName.get('channel.email.curia.nylas_grant_id')).toMatchObject({
      kind: 'system', configured: true, required: false, declaredBy: [],
    });
    expect(list.map(s => s.name)).toEqual([...list.map(s => s.name)].sort((a, b) => a.localeCompare(b)));
  });

  describe('GET /api/vault/secrets row assembly', () => {
    const STORED = ['tavily_api_key', 'openrouter_api_key', 'user.rogers_password', 'old_tool_key'];
    const details = { 'user.rogers_password': { loginUrl: 'https://rogers.example/login', username: 'joseph' } };
    function mcpDeclaring(key: string): McpRegistryService {
      return {
        declaredSecretKeys: () => [key],
        enabledServerNames: async () => new Set(['linear']),
        secretDeclarations: () => [{ key, server: 'linear', required: true }],
      } as unknown as McpRegistryService;
    }
    async function rows(a: FastifyInstance) {
      const res = await a.inject({ method: 'GET', url: '/api/vault/secrets', headers: auth });
      expect(res.statusCode).toBe(200);
      const list = res.json().secrets as Array<Record<string, unknown>>;
      return { res, byName: new Map(list.map(r => [r['name'] as string, r])) };
    }

    it('lists personal, system, platform and orphan rows', async () => {
      app = await build(fakeSecrets(STORED, details), fakeRegistry(['tavily_api_key'], [toolEntry('web-search', 'enabled', ['tavily_api_key'])]), { mcp: mcpDeclaring('linear_api_key') });
      const { byName } = await rows(app);
      expect(byName.get('tavily_api_key')).toMatchObject({ kind: 'system', configured: true });
      expect(byName.get('openrouter_api_key')).toMatchObject({
        kind: 'platform', configured: true, required: true,
        declaredBy: [{ kind: 'platform', name: 'LLM provider (OpenRouter)', required: true, enabled: true }],
      });
      expect(byName.get('user.rogers_password')).toMatchObject({ kind: 'personal', configured: true, required: false, declaredBy: [] });
      expect(byName.get('old_tool_key')).toMatchObject({ kind: 'system', configured: true, declaredBy: [] });
      expect(byName.get('linear_api_key')).toMatchObject({ kind: 'system', configured: false, valueFormat: null, createdAt: null, updatedAt: null });
    });

    it('marks a personal key required while an enabled tool requires it, as the delete guard does', async () => {
      app = await build(fakeSecrets(STORED, details), fakeRegistry(['user.rogers_password'], [toolEntry('bank-sync', 'enabled', ['user.rogers_password'])]));
      const { byName } = await rows(app);
      expect(byName.get('user.rogers_password')).toMatchObject({
        kind: 'personal', required: true, declaredBy: [{ kind: 'tool', name: 'bank-sync', required: true, enabled: true }],
      });
      // And DELETE agrees: it is refused without force.
      expect((await del(app, encodeURIComponent('user.rogers_password'))).statusCode).toBe(409);
    });

    it('lists a declared platform key that is not in the vault as platform, not system', async () => {
      app = await build(fakeSecrets([]), fakeRegistry(['anthropic_api_key'], [toolEntry('t', 'enabled', ['anthropic_api_key'])]));
      const { byName } = await rows(app);
      expect(byName.get('anthropic_api_key')).toMatchObject({ kind: 'platform', configured: false, required: true });
      // The write route refuses it, so the page must not offer Set.
      expect((await put(app, 'anthropic_api_key', { value: 'k' })).statusCode).toBe(403);
    });

    it('personal rows carry sign-in details and no value', async () => {
      const secrets = fakeSecrets(STORED, details);
      await secrets.set('user.rogers_password', 'hunter2-stored-value');
      app = await build(secrets, fakeRegistry([]));
      const { res, byName } = await rows(app);
      expect(byName.get('user.rogers_password')).toMatchObject({ loginUrl: 'https://rogers.example/login', username: 'joseph' });
      expect(byName.get('tavily_api_key')).not.toHaveProperty('loginUrl');
      expect(res.body).not.toContain('hunter2-stored-value');
    });

    it('dates and lastUsedAt come from metadata and usage', async () => {
      const usage: SecretUsagePort = {
        lastUsedByName: async (names: readonly string[]) => new Map(names.includes('user.rogers_password') ? [['user.rogers_password', new Date('2026-10-01T00:00:00.000Z')]] : []),
        recentUses: async () => [],
      };
      app = await build(fakeSecrets(STORED, details), fakeRegistry([]), { usage });
      const { byName } = await rows(app);
      expect(byName.get('user.rogers_password')).toMatchObject({
        valueFormat: 'string', createdAt: CREATED.toISOString(), updatedAt: UPDATED.toISOString(), lastUsedAt: '2026-10-01T00:00:00.000Z',
      });
      expect(byName.get('tavily_api_key')).toMatchObject({ lastUsedAt: null });
      await app.close();
      app = await build(fakeSecrets(STORED, details), fakeRegistry([]));
      expect((await rows(app)).byName.get('user.rogers_password')).toMatchObject({ lastUsedAt: null });
    });

    it('readAtStartup is true for platform and channel rows, false for tool-declared and personal rows', async () => {
      app = await build(
        fakeSecrets([...STORED, 'channel.slack.bot_token'], details),
        fakeRegistry(['tavily_api_key'], [toolEntry('web-search', 'enabled', ['tavily_api_key'])]),
      );
      const { byName } = await rows(app);
      expect(byName.get('openrouter_api_key')).toMatchObject({ readAtStartup: true });
      expect(byName.get('channel.slack.bot_token')).toMatchObject({ readAtStartup: true });
      expect(byName.get('tavily_api_key')).toMatchObject({ readAtStartup: false });
      expect(byName.get('user.rogers_password')).toMatchObject({ readAtStartup: false });
      expect(byName.get('old_tool_key')).toMatchObject({ readAtStartup: false });
    });

    it('a platform key that is also declared stays platform', async () => {
      app = await build(fakeSecrets(['openrouter_api_key']), fakeRegistry([]), { mcp: mcpDeclaring('openrouter_api_key') });
      const { byName } = await rows(app);
      const row = byName.get('openrouter_api_key') as { kind: string; declaredBy: Array<{ kind: string }> };
      expect(row.kind).toBe('platform');
      expect(row.declaredBy.map(d => d.kind).sort()).toEqual(['mcp', 'platform']);
    });
  });

  // --- platform guard, personal create/edit, wider delete, recent uses (Task 6) ---

  const PLATFORM_REFUSAL = 'Managed by deployment — change it in the deploy environment, not here.';

  function post(a: FastifyInstance, url: string, body: unknown) {
    return a.inject({ method: 'POST', url, headers: auth, payload: body as object });
  }
  function patch(a: FastifyInstance, name: string, body: unknown) {
    return a.inject({ method: 'PATCH', url: `/api/vault/user-secrets/${encodeURIComponent(name)}`, headers: auth, payload: body as object });
  }
  const changes = (published: Array<{ type: string; payload: Record<string, unknown> }>) =>
    published.filter(e => e.type === 'secret.changed').map(e => `${String(e.payload['action'])}:${String(e.payload['stage'])}`);

  describe('platform guard', () => {
    it('PUT, DELETE and PATCH refuse a platform key with 403', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['openrouter_api_key']);
      // Even a registry that declares the key does not make it writable here.
      app = await build(secrets, fakeRegistry(['openrouter_api_key']), { bus });
      for (const res of [
        await put(app, 'openrouter_api_key', { value: 'sk-or-new' }),
        await del(app, 'openrouter_api_key', '?force=true'),
        await patch(app, 'openrouter_api_key', { value: 'sk-or-new' }),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: PLATFORM_REFUSAL });
      }
      expect(published).toEqual([]);
      expect(secrets.sets).toEqual([]);
      expect(secrets.deletes).toEqual([]);
      expect(secrets.patches).toEqual([]);
    });
  });

  describe('POST /api/vault/user-secrets', () => {
    it('POST user-secrets creates user.rogers_password with details', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets();
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await post(app, '/api/vault/user-secrets', {
        type: 'website_login', loginUrl: 'https://www.rogers.com/signin', username: 'u@example.com', value: 'pw-123',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: 'user.rogers_password', replaced: false });
      expect(res.body).not.toContain('pw-123');
      expect(secrets.sets).toEqual([{ name: 'user.rogers_password', value: 'pw-123' }]);
      expect(secrets.upserts).toEqual([{ name: 'user.rogers_password', details: { loginUrl: 'https://www.rogers.com/signin', username: 'u@example.com' } }]);
      expect(changes(published)).toEqual(['set:requested', 'set:completed']);
      expect(published.every(e => e.payload['secretName'] === 'user.rogers_password')).toBe(true);
      expect(JSON.stringify(published)).not.toContain('pw-123');
    });

    it('POST replaces an existing key and keeps blank details', async () => {
      const secrets = fakeSecrets(['user.rogers_password'], { 'user.rogers_password': { username: 'old' } });
      app = await build(secrets, fakeRegistry());
      const res = await post(app, '/api/vault/user-secrets', {
        type: 'website_login', loginUrl: 'https://www.rogers.com/signin', value: 'pw-new',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: 'user.rogers_password', replaced: true });
      expect(secrets.upserts).toHaveLength(1);
      expect(secrets.upserts[0]!.details).not.toHaveProperty('username');
    });

    it('POST with no details writes no details row', async () => {
      const secrets = fakeSecrets();
      app = await build(secrets, fakeRegistry());
      const res = await post(app, '/api/vault/user-secrets', { type: 'other', label: 'Garage code', value: '4321' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: 'user.garage_code', replaced: false });
      expect(secrets.upserts).toEqual([]);
    });

    it('POST refuses to replace a JSON-valued key', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password'], {}, { 'user.rogers_password': 'json' });
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await post(app, '/api/vault/user-secrets', {
        type: 'website_login', loginUrl: 'https://www.rogers.com/signin', value: 'pw-new',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "'user.rogers_password' holds a structured value. Recapture through Curia to change a structured value.",
      });
      expect(secrets.sets).toEqual([]);
      expect(published).toEqual([]);
    });

    // A capture can turn the key into JSON between the check and the write; the write itself
    // refuses then, and the change gets no completed row.
    it('POST refuses when the key became structured after its check', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets([]);
      secrets.setUserSecret = async () => ({ outcome: 'structured' as const });
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await post(app, '/api/vault/user-secrets', {
        type: 'website_login', loginUrl: 'https://www.rogers.com/signin', value: 'pw-new',
      });
      expect(res.statusCode).toBe(409);
      expect(changes(published)).toEqual(['set:requested']);
    });

    it('POST writes no completed row when the combined write fails', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets([]);
      secrets.setUserSecret = async () => { throw new Error('db down'); };
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await post(app, '/api/vault/user-secrets', {
        type: 'website_login', loginUrl: 'https://www.rogers.com/signin', username: 'u', value: 'pw-new',
      });
      expect(res.statusCode).toBe(500);
      expect(changes(published)).toEqual(['set:requested']);
    });

    it('POST and PATCH reject a whitespace-only value', async () => {
      const secrets = fakeSecrets(['user.rogers_password']);
      app = await build(secrets, fakeRegistry());
      const created = await post(app, '/api/vault/user-secrets', { type: 'other', label: 'Garage code', value: '   ' });
      expect(created.statusCode).toBe(400);
      const edited = await patch(app, 'user.rogers_password', { value: ' \t ' });
      expect(edited.statusCode).toBe(400);
      expect(secrets.sets).toEqual([]);
    });

    it('POST names before parsing details, so a bad URL gets the naming message', async () => {
      const secrets = fakeSecrets();
      app = await build(secrets, fakeRegistry());
      const bad = await post(app, '/api/vault/user-secrets', { type: 'website_login', loginUrl: 'ftp://x', value: 'v' });
      const preview = await post(app, '/api/vault/user-secrets/preview', { type: 'website_login', loginUrl: 'ftp://x' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe(preview.json().error);
      expect(secrets.sets).toEqual([]);
    });

    it('POST rejects an oversized value, a bad type and bad details', async () => {
      const secrets = fakeSecrets();
      app = await build(secrets, fakeRegistry());
      expect((await post(app, '/api/vault/user-secrets', { type: 'other', label: 'x', value: 'x'.repeat(8193) })).statusCode).toBe(400);
      expect((await post(app, '/api/vault/user-secrets', { type: 'card', label: 'x', value: 'v' })).statusCode).toBe(400);
      const creds = await post(app, '/api/vault/user-secrets', { type: 'website_login', loginUrl: 'https://me:pw@rogers.com/', value: 'v' });
      expect(creds.statusCode).toBe(400);
      expect(creds.json().error).toMatch(/credentials/);
      expect(secrets.sets).toEqual([]);
    });
  });

  describe('POST /api/vault/user-secrets/preview', () => {
    it('preview reports the existing key', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password']);
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await post(app, '/api/vault/user-secrets/preview', { type: 'website_login', loginUrl: 'https://www.rogers.com/signin' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: 'user.rogers_password', existing: { updatedAt: UPDATED.toISOString(), valueFormat: 'string', schema: null } });
      expect(published).toEqual([]);
      expect(secrets.sets).toEqual([]);
    });

    it('preview names a new key with no existing entry', async () => {
      app = await build(fakeSecrets(), fakeRegistry());
      const res = await post(app, '/api/vault/user-secrets/preview', { type: 'other', label: 'Garage code' });
      expect(res.json()).toEqual({ name: 'user.garage_code', existing: null });
    });

    it('preview 400s a bad URL', async () => {
      app = await build(fakeSecrets(), fakeRegistry());
      const res = await post(app, '/api/vault/user-secrets/preview', { type: 'website_login', loginUrl: 'ftp://x' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('login URL must be http or https');
    });
  });

  describe('PATCH /api/vault/user-secrets/:name', () => {
    it('PATCH details-only never writes the value', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password']);
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await patch(app, 'user.rogers_password', { username: 'new@example.com' });
      expect(res.statusCode).toBe(200);
      expect(secrets.sets).toEqual([]);
      expect(secrets.patches).toEqual([{ name: 'user.rogers_password', patch: { username: 'new@example.com' } }]);
      expect(changes(published)).toEqual(['details:requested', 'details:completed']);
    });

    it('PATCH null clears a field', async () => {
      const secrets = fakeSecrets(['user.rogers_password']);
      app = await build(secrets, fakeRegistry());
      expect((await patch(app, 'user.rogers_password', { username: null })).statusCode).toBe(200);
      expect((await patch(app, 'user.rogers_password', { loginUrl: '' })).statusCode).toBe(200);
      expect(secrets.patches).toEqual([
        { name: 'user.rogers_password', patch: { username: null } },
        { name: 'user.rogers_password', patch: { loginUrl: null } },
      ]);
    });

    it('PATCH with value and details audits both actions', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password']);
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await patch(app, 'user.rogers_password', { value: 'pw-patched', loginUrl: 'https://rogers.com/login' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('pw-patched');
      expect(secrets.sets).toEqual([{ name: 'user.rogers_password', value: 'pw-patched' }]);
      expect(secrets.patches).toEqual([{ name: 'user.rogers_password', patch: { loginUrl: 'https://rogers.com/login' } }]);
      expect(changes(published)).toEqual(['set:requested', 'details:requested', 'set:completed', 'details:completed']);
      expect(JSON.stringify(published)).not.toContain('pw-patched');
    });

    // Value and details are one transaction (SecretsService.editUserSecret): a failure keeps
    // neither, so neither change gets a completed row.
    it('PATCH writes no completed row when the combined write fails', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password']);
      secrets.editUserSecret = async () => { throw new Error('db down'); };
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await patch(app, 'user.rogers_password', { value: 'pw-patched', username: 'u' });
      expect(res.statusCode).toBe(500);
      expect(changes(published)).toEqual(['set:requested', 'details:requested']);
    });

    it('PATCH reports a key deleted since its check as gone, and recreates nothing', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password']);
      secrets.editUserSecret = async () => ({ outcome: 'missing' as const });
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await patch(app, 'user.rogers_password', { value: 'pw' });
      expect(res.statusCode).toBe(404);
      expect(changes(published)).toEqual(['set:requested']);
    });

    it('PATCH refuses a key that became structured since its check', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password']);
      secrets.editUserSecret = async () => ({ outcome: 'structured' as const });
      app = await build(secrets, fakeRegistry(), { bus });
      expect((await patch(app, 'user.rogers_password', { value: 'pw' })).statusCode).toBe(409);
      expect(changes(published)).toEqual(['set:requested']);
    });

    it('PATCH with only a value never touches the details', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password']);
      app = await build(secrets, fakeRegistry(), { bus });
      expect((await patch(app, 'user.rogers_password', { value: 'pw-only' })).statusCode).toBe(200);
      expect(secrets.patches).toEqual([]);
      expect(changes(published)).toEqual(['set:requested', 'set:completed']);
    });

    it('PATCH with no fields is a 400 and writes nothing', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password']);
      app = await build(secrets, fakeRegistry(), { bus });
      expect((await patch(app, 'user.rogers_password', {})).statusCode).toBe(400);
      expect(secrets.patches).toEqual([]);
      expect(published).toEqual([]);
    });

    it('PATCH refuses a non-personal name and bad details', async () => {
      const secrets = fakeSecrets([DECLARED_SECRET, 'user.rogers_password']);
      app = await build(secrets, fakeRegistry());
      expect((await patch(app, DECLARED_SECRET, { value: 'x' })).statusCode).toBe(400);
      expect((await patch(app, 'user.rogers_password', { loginUrl: 'not a url' })).statusCode).toBe(400);
      expect((await patch(app, 'user.rogers_password', { username: 42 })).statusCode).toBe(400);
      // A malformed URL with userinfo must not be echoed back in the error.
      const leaky = await patch(app, 'user.rogers_password', { loginUrl: 'https://someone:hunter2@[bad' });
      expect(leaky.statusCode).toBe(400);
      expect(leaky.body).not.toContain('hunter2');
      const leakyPost = await post(app, '/api/vault/user-secrets', {
        type: 'other', label: 'x', value: 'v', loginUrl: 'https://someone:hunter2@[bad',
      });
      expect(leakyPost.statusCode).toBe(400);
      expect(leakyPost.body).not.toContain('hunter2');
      expect(secrets.sets).toEqual([]);
      expect(secrets.patches).toEqual([]);
    });

    it('PATCH on a removed key 404s and writes nothing', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets();
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await patch(app, 'user.rogers_password', { value: 'pw', username: 'u' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "'user.rogers_password' no longer exists." });
      expect(secrets.sets).toEqual([]);
      expect(secrets.patches).toEqual([]);
      expect(published).toEqual([]);
    });

    it('PATCH on a JSON-valued key with a value 409s; with details only succeeds', async () => {
      const secrets = fakeSecrets(['user.aeroplan_login'], {}, { 'user.aeroplan_login': 'json' });
      app = await build(secrets, fakeRegistry());
      const refused = await patch(app, 'user.aeroplan_login', { value: 'pw', username: 'u' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("'user.aeroplan_login' holds a structured value. Recapture through Curia to change a structured value.");
      expect(secrets.patches).toEqual([]);
      expect((await patch(app, 'user.aeroplan_login', { username: 'u' })).statusCode).toBe(200);
      expect(secrets.sets).toEqual([]);
      expect(secrets.patches).toEqual([{ name: 'user.aeroplan_login', patch: { username: 'u' } }]);
    });
  });

  describe('wider DELETE', () => {
    it('DELETE removes a user.* key and its details', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets(['user.rogers_password'], { 'user.rogers_password': { username: 'u' } });
      app = await build(secrets, fakeRegistry(), { bus });
      const res = await del(app, encodeURIComponent('user.rogers_password'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, removed: true });
      // One call: SecretsService.delete removes the details in the same transaction.
      expect(secrets.deletes).toEqual(['user.rogers_password']);
      expect(secrets.detailDeletes).toEqual([]);
      expect(changes(published)).toEqual(['delete:requested', 'delete:completed']);
    });

    it('DELETE removes an orphaned key', async () => {
      const secrets = fakeSecrets(['old_tool_key']);
      app = await build(secrets, fakeRegistry([]));
      const res = await del(app, 'old_tool_key');
      expect(res.statusCode).toBe(200);
      expect(secrets.deletes).toEqual(['old_tool_key']);
      expect(secrets.detailDeletes).toEqual([]);
    });

    it('leftover retired Nylas rows are unlocked orphans the operator can delete (#2522)', async () => {
      const LEGACY = ['nylas_grant_id', 'nylas_self_email'];
      const secrets = fakeSecrets([...LEGACY, 'channel.email.nylas_api_key']);
      app = await build(secrets, fakeRegistry([]));
      const res = await app.inject({ method: 'GET', url: '/api/vault/secrets', headers: auth });
      const byName = new Map((res.json().secrets as Array<{ name: string; kind: string }>).map(s => [s.name, s]));
      for (const name of LEGACY) {
        expect(byName.get(name)).toMatchObject({ kind: 'system', configured: true, required: false, declaredBy: [] });
      }
      // The canonical key alone satisfies the email channel's row: nothing reads as missing.
      expect(byName.get('channel.email.nylas_api_key')).toMatchObject({ configured: true });
      expect([...byName.values()].filter(s => s.name.startsWith('nylas_')).map(s => s.kind)).not.toContain('platform');
      for (const name of LEGACY) expect((await del(app, name)).statusCode).toBe(200);
      expect(secrets.deletes).toEqual(LEGACY);
    });

    it('DELETE still 400s a name that is neither declared nor in the vault', async () => {
      const secrets = fakeSecrets();
      app = await build(secrets, fakeRegistry([]));
      expect((await del(app, 'old_tool_key')).statusCode).toBe(400);
      expect((await del(app, 'user.nothing_here')).statusCode).toBe(400);
      expect(secrets.deletes).toEqual([]);
    });

    it('DELETE a dotted email-grant name', async () => {
      const name = 'channel.email.my-acct.nylas_grant_id';
      const secrets = fakeSecrets([name]);
      app = await build(secrets, fakeRegistry());
      const res = await del(app, encodeURIComponent(name));
      expect(res.statusCode).toBe(200);
      expect(secrets.deletes).toEqual([name]);
    });
  });

  describe('GET /api/vault/secrets/:name/uses', () => {
    const USE: SecretUse = { kind: 'read', at: new Date('2026-10-30T12:00:00.000Z'), agentId: 'coordinator', toolName: 'browser-login', source: 'vault', byReference: true, secretField: null };
    function recordingUsage() {
      const calls: Array<{ name: string; limit: number }> = [];
      const usage: SecretUsagePort = {
        lastUsedByName: async () => new Map(),
        recentUses: async (name, limit) => { calls.push({ name, limit }); return [USE]; },
      };
      return { usage, calls };
    }

    it("GET uses returns the repo's rows, clamps limit", async () => {
      const { usage, calls } = recordingUsage();
      app = await build(fakeSecrets(), fakeRegistry(), { usage });
      const res = await app.inject({ method: 'GET', url: '/api/vault/secrets/tavily_api_key/uses?limit=500', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        uses: [{ kind: 'read', at: '2026-10-30T12:00:00.000Z', agentId: 'coordinator', toolName: 'browser-login', source: 'vault', byReference: true }],
      });
      await app.inject({ method: 'GET', url: '/api/vault/secrets/tavily_api_key/uses', headers: auth });
      await app.inject({ method: 'GET', url: '/api/vault/secrets/tavily_api_key/uses?limit=0', headers: auth });
      await app.inject({ method: 'GET', url: '/api/vault/secrets/tavily_api_key/uses?limit=abc', headers: auth });
      expect(calls.map(c => c.limit)).toEqual([20, 5, 1, 5]);
    });

    it('GET uses works for a dotted, encoded name', async () => {
      const { usage, calls } = recordingUsage();
      app = await build(fakeSecrets(), fakeRegistry(), { usage });
      const name = 'channel.email.my-acct.nylas_grant_id';
      const res = await app.inject({ method: 'GET', url: `/api/vault/secrets/${encodeURIComponent(name)}/uses?limit=3`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(calls).toEqual([{ name, limit: 3 }]);
      const personal = await app.inject({ method: 'GET', url: `/api/vault/secrets/${encodeURIComponent('user.rogers_password')}/uses`, headers: auth });
      expect(personal.statusCode).toBe(200);
      expect(calls[1]).toEqual({ name: 'user.rogers_password', limit: 5 });
    });

    it('GET uses is empty when no usage source is wired, and needs auth', async () => {
      app = await build(fakeSecrets(), fakeRegistry());
      const res = await app.inject({ method: 'GET', url: '/api/vault/secrets/k/uses', headers: auth });
      expect(res.json()).toEqual({ uses: [] });
      expect((await app.inject({ method: 'GET', url: '/api/vault/secrets/k/uses' })).statusCode).toBe(401);
    });
  });

  // --- saved cards (#1358, Task 13) ---

  describe('saved cards', () => {
    const CARD_KEY = 'user.personal_visa_card';
    const NUMBER = '4111111111111111';
    const CARD = { number: NUMBER, cvv: '123', expiry_month: 12, expiry_year: 2099, cardholder_name: 'Joseph Fung' };
    const PUB: CreditCardPublicFields = { brand: 'visa', last4: '1111', expiry_month: '12', expiry_year: '2099', cardholder_name: 'Joseph Fung' };
    const savedCard = (over: Partial<UserSecretDetails> = {}): Record<string, UserSecretDetails> => ({
      [CARD_KEY]: { schema: 'credit_card', label: 'Personal', publicFields: PUB, ...over },
    });
    const FORMATS = { [CARD_KEY]: 'json' as const };

    it('list returns a card summary without decrypting', async () => {
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]));
      const res = await app.inject({ method: 'GET', url: '/api/vault/secrets', headers: auth });
      const row = (res.json().secrets as Array<Record<string, unknown>>).find(r => r['name'] === CARD_KEY)!;
      expect(row).toMatchObject({
        kind: 'personal', configured: true,
        card: { label: 'Personal', brand: 'visa', last4: '1111', expiry: '12/2099', cardholder_name: 'Joseph Fung', billing_zip: null, expired: false },
      });
      expect(secrets.decrypts).not.toHaveBeenCalled();
      expect(res.body).not.toContain(NUMBER);
    });

    it('list carries the cardholder name and billing postal code, still without decrypting', async () => {
      const secrets = fakeSecrets([CARD_KEY], savedCard({ publicFields: { ...PUB, billing_zip: 'N2L 3G1' } }), FORMATS);
      app = await build(secrets, fakeRegistry([]));
      const res = await app.inject({ method: 'GET', url: '/api/vault/secrets', headers: auth });
      const row = (res.json().secrets as Array<Record<string, unknown>>).find(r => r['name'] === CARD_KEY)!;
      expect(row['card']).toMatchObject({ cardholder_name: 'Joseph Fung', billing_zip: 'N2L 3G1' });
      expect(secrets.decrypts).not.toHaveBeenCalled();
    });

    it('expired card status is expired', async () => {
      const expiredPub = { ...PUB, expiry_month: '01', expiry_year: '2020' };
      app = await build(fakeSecrets([CARD_KEY], savedCard({ publicFields: expiredPub, label: undefined }), FORMATS), fakeRegistry([]));
      const res = await app.inject({ method: 'GET', url: '/api/vault/secrets', headers: auth });
      const row = (res.json().secrets as Array<Record<string, unknown>>).find(r => r['name'] === CARD_KEY)!;
      expect(row['card']).toEqual({ label: null, brand: 'visa', last4: '1111', expiry: '01/2020', cardholder_name: 'Joseph Fung', billing_zip: null, expired: true });
      expect(row['configured']).toBe(true);
    });

    it('create card calls setCard; response and audit payloads carry no number or cvv', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets();
      app = await build(secrets, fakeRegistry([]), { bus });
      const res = await post(app, '/api/vault/user-secrets', {
        type: 'credit_card', label: 'Personal', card: { ...CARD, billing_zip: 'M5V 2T6' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: CARD_KEY, replaced: false });
      expect(secrets.cardSets).toEqual([{
        name: CARD_KEY,
        secret: { _schema: 'credit_card', number: NUMBER, cvv: '123' },
        publicFields: { ...PUB, billing_zip: 'M5V 2T6' },
        label: 'Personal',
      }]);
      expect(secrets.sets).toEqual([]);
      expect(changes(published)).toEqual(['set:requested', 'set:completed']);
      for (const text of [res.body, JSON.stringify(published)]) {
        expect(text).not.toContain(NUMBER);
        expect(text).not.toContain('"123"');
      }
    });

    it('create card replaces an existing card and refuses an untagged JSON key', async () => {
      const replaced = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(replaced, fakeRegistry([]));
      const res = await post(app, '/api/vault/user-secrets', { type: 'credit_card', label: 'Personal', card: CARD });
      expect(res.json()).toEqual({ name: CARD_KEY, replaced: true });
      expect(replaced.cardSets).toHaveLength(1);
      await app.close();

      const { bus, published } = fakeBus();
      const untagged = fakeSecrets([CARD_KEY], {}, FORMATS);
      app = await build(untagged, fakeRegistry([]), { bus });
      const refused = await post(app, '/api/vault/user-secrets', { type: 'credit_card', label: 'Personal', card: CARD });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toContain('structured value');
      expect(untagged.cardSets).toEqual([]);
      expect(published).toEqual([]);
    });

    it('create card refuses to overwrite a plain string secret', async () => {
      const secrets = fakeSecrets([CARD_KEY]);
      app = await build(secrets, fakeRegistry([]));
      const res = await post(app, '/api/vault/user-secrets', { type: 'credit_card', label: 'Personal', card: CARD });
      expect(res.statusCode).toBe(409);
      expect(secrets.cardSets).toEqual([]);
    });

    it('create card validation failure is a 400 with the message and writes nothing', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets();
      app = await build(secrets, fakeRegistry([]), { bus });
      const badLuhn = await post(app, '/api/vault/user-secrets', { type: 'credit_card', label: 'Personal', card: { ...CARD, number: '4111111111111112' } });
      expect(badLuhn.statusCode).toBe(400);
      expect(badLuhn.json()).toEqual({ error: CARD_VALIDATION_MESSAGES.number_checksum });
      const badCvv = await post(app, '/api/vault/user-secrets', { type: 'credit_card', label: 'Personal', card: { ...CARD, cvv: '12' } });
      expect(badCvv.json()).toEqual({ error: CARD_VALIDATION_MESSAGES.cvv_format });
      const expired = await post(app, '/api/vault/user-secrets', { type: 'credit_card', label: 'Personal', card: { ...CARD, expiry_year: 2020 } });
      expect(expired.json()).toEqual({ error: CARD_VALIDATION_MESSAGES.expired });
      const noCard = await post(app, '/api/vault/user-secrets', { type: 'credit_card', label: 'Personal' });
      expect(noCard.statusCode).toBe(400);
      const noLabel = await post(app, '/api/vault/user-secrets', { type: 'credit_card', card: CARD });
      expect(noLabel.statusCode).toBe(400);
      for (const res of [badLuhn, badCvv, expired, noCard, noLabel]) {
        expect(res.body).not.toContain(NUMBER);
        expect(res.body).not.toContain('4111111111111112');
      }
      expect(secrets.cardSets).toEqual([]);
      expect(published).toEqual([]);
    });

    it('preview names user.personal_visa_card from label and number, without echoing them', async () => {
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]));
      const res = await post(app, '/api/vault/user-secrets/preview', { type: 'credit_card', label: 'Personal', card: { number: '4111 1111 1111 1111', cvv: '999' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: CARD_KEY, existing: { updatedAt: UPDATED.toISOString(), valueFormat: 'json', schema: 'credit_card' } });
      expect(res.body).not.toContain('4111');
      expect(res.body).not.toContain('999');
      expect(secrets.cardSets).toEqual([]);

      const amex = await post(app, '/api/vault/user-secrets/preview', { type: 'credit_card', label: 'Work', card: { number: '378282246310005' } });
      expect(amex.json().name).toBe('user.work_amex_card');
      // A short prefix is enough to name the card: it need not be a valid number.
      const prefix = await post(app, '/api/vault/user-secrets/preview', { type: 'credit_card', label: 'Work', card: { number: '37' } });
      expect(prefix.statusCode).toBe(200);
      expect(prefix.json().name).toBe('user.work_amex_card');
      expect((await post(app, '/api/vault/user-secrets/preview', { type: 'credit_card', label: 'Work', card: {} })).statusCode).toBe(400);
      expect((await post(app, '/api/vault/user-secrets/preview', { type: 'credit_card', card: { number: NUMBER } })).statusCode).toBe(400);
    });

    it('patch label and expiry audits details and writes no secret', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]), { bus });
      const res = await patch(app, CARD_KEY, { label: 'Everyday', expiry_month: 3, expiry_year: 2099, billing_zip: '' });
      expect(res.statusCode).toBe(200);
      expect(secrets.cardPatches).toEqual([{ name: CARD_KEY, patch: { label: 'Everyday', publicFields: { ...PUB, expiry_month: '03' }, basedOn: PUB } }]);
      expect(secrets.cardReplaces).toEqual([]);
      expect(secrets.sets).toEqual([]);
      expect(changes(published)).toEqual(['details:requested', 'details:completed']);
    });

    it("patch '' clears the label and the billing postal code", async () => {
      const withZip = savedCard({ publicFields: { ...PUB, billing_zip: 'M5V' } });
      const secrets = fakeSecrets([CARD_KEY], withZip, FORMATS);
      app = await build(secrets, fakeRegistry([]));
      expect((await patch(app, CARD_KEY, { label: '', billing_zip: '' })).statusCode).toBe(200);
      expect(secrets.cardPatches).toEqual([{ name: CARD_KEY, patch: { label: null, publicFields: PUB, basedOn: { ...PUB, billing_zip: 'M5V' } } }]);
    });

    it('patch rejects an invalid public field with the message', async () => {
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]));
      const res = await patch(app, CARD_KEY, { expiry_year: 2020 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: CARD_VALIDATION_MESSAGES.expired });
      expect((await patch(app, CARD_KEY, { cardholder_name: ' ' })).json()).toEqual({ error: CARD_VALIDATION_MESSAGES.cardholder_missing });
      expect(secrets.cardPatches).toEqual([]);
    });

    it('patch cvv keeps the number', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]), { bus });
      const res = await patch(app, CARD_KEY, { cvv: '456' });
      expect(res.statusCode).toBe(200);
      expect(secrets.cardReplaces).toEqual([{ name: CARD_KEY, change: { cvv: '456' } }]);
      expect(secrets.cardPatches).toEqual([]);
      expect(changes(published)).toEqual(['set:requested', 'set:completed']);
      // Each event's random id and timestamp can spell "456" by chance (#2548): blank only
      // those, then look for the digits anywhere else, so `cvv_456` or `x456` still fail.
      expect(serializeForLeakCheck(published)).not.toContain('456');
      expect(res.body).not.toContain('456');
      expect((await patch(app, CARD_KEY, { cvv: '4567' })).json()).toEqual({ error: CARD_VALIDATION_MESSAGES.cvv_format });
    });

    it('patch cvv with expiry is one atomic renewal audited as set; a label rides separately as details', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]), { bus });
      const res = await patch(app, CARD_KEY, { cvv: '456', expiry_month: 3, expiry_year: 2100 });
      expect(res.statusCode).toBe(200);
      expect(secrets.cardRenewals).toEqual([{ name: CARD_KEY, change: { cvv: '456', publicFields: { ...PUB, expiry_month: '03', expiry_year: '2100' }, basedOn: PUB } }]);
      expect(secrets.cardReplaces).toEqual([]);
      expect(secrets.cardPatches).toEqual([]);
      expect(changes(published)).toEqual(['set:requested', 'set:completed']);
      expect(serializeForLeakCheck(published)).not.toContain('456');

      published.length = 0;
      await patch(app, CARD_KEY, { cvv: '456', expiry_year: 2100, label: 'Everyday' });
      expect(secrets.cardRenewals).toHaveLength(2);
      expect(secrets.cardPatches).toEqual([{ name: CARD_KEY, patch: { label: 'Everyday' } }]);
      expect(changes(published)).toEqual(['set:requested', 'details:requested', 'set:completed', 'details:completed']);
    });

    it('a stale edit (renewal or public-field patch) is a 409 the console can retry, not a 500', async () => {
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      const stale = async () => { throw new StaleCardEditError('card changed while this edit was prepared; try again'); };
      secrets.renewCard = stale;
      secrets.patchCardPublic = stale;
      app = await build(secrets, fakeRegistry([]), {});
      const renewal = await patch(app, CARD_KEY, { cvv: '456', expiry_month: 3, expiry_year: 2100 });
      expect(renewal.statusCode).toBe(409);
      expect(renewal.json()).toEqual({ error: 'card changed while this edit was prepared; try again' });
      const publicEdit = await patch(app, CARD_KEY, { expiry_month: 3, expiry_year: 2100 });
      expect(publicEdit.statusCode).toBe(409);
    });

    it('patch replace swaps the card', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]), { bus });
      const res = await patch(app, CARD_KEY, { replace: { ...CARD, number: '5555555555554444' } });
      expect(res.statusCode).toBe(200);
      expect(secrets.cardReplaces).toEqual([{
        name: CARD_KEY,
        change: {
          secret: { _schema: 'credit_card', number: '5555555555554444', cvv: '123' },
          publicFields: { ...PUB, brand: 'mastercard', last4: '4444' },
        },
      }]);
      expect(changes(published)).toEqual(['set:requested', 'set:completed']);
      expect(JSON.stringify(published)).not.toContain('5555555555554444');
      const bad = await patch(app, CARD_KEY, { replace: { ...CARD, number: '1234' } });
      expect(bad.json()).toEqual({ error: CARD_VALIDATION_MESSAGES.number_format });
      const mixed = await patch(app, CARD_KEY, { replace: CARD, label: 'x' });
      expect(mixed.statusCode).toBe(400);
      expect(secrets.cardReplaces).toHaveLength(1);
    });

    it('value on a card is a 409', async () => {
      const { bus, published } = fakeBus();
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]), { bus });
      const res = await patch(app, CARD_KEY, { value: 'hunter2' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Use the card fields to change a saved card.' });
      expect(secrets.sets).toEqual([]);
      expect(published).toEqual([]);
    });

    it('patch on a card with nothing to change is a 400, and a removed card is a 404', async () => {
      const secrets = fakeSecrets([CARD_KEY], savedCard(), FORMATS);
      app = await build(secrets, fakeRegistry([]));
      expect((await patch(app, CARD_KEY, {})).statusCode).toBe(400);
      await app.close();
      app = await build(fakeSecrets([], savedCard(), FORMATS), fakeRegistry([]));
      expect((await patch(app, CARD_KEY, { label: 'x' })).statusCode).toBe(404);
    });

    it('platform-key guard still comes first on card routes', async () => {
      const secrets = fakeSecrets(['openrouter_api_key']);
      app = await build(secrets, fakeRegistry([]));
      expect((await patch(app, 'openrouter_api_key', { cvv: '123' })).statusCode).toBe(403);
    });

    it('asks for card-use decisions only for a saved card', async () => {
      const flags: Array<boolean | undefined> = [];
      const usage: SecretUsagePort = {
        lastUsedByName: async () => new Map(),
        recentUses: async (_n, _l, includeCardUses) => { flags.push(includeCardUses); return []; },
      };
      app = await build(fakeSecrets([CARD_KEY, 'user.rogers_password'], savedCard(), FORMATS), fakeRegistry([]), { usage });
      for (const n of [CARD_KEY, 'user.rogers_password', 'tavily_api_key']) {
        await app.inject({ method: 'GET', url: `/api/vault/secrets/${encodeURIComponent(n)}/uses`, headers: auth });
      }
      expect(flags).toEqual([true, false, false]);
    });

    it('uses include secretField and card_use items', async () => {
      const usage: SecretUsagePort = {
        lastUsedByName: async () => new Map(),
        recentUses: async () => [
          { kind: 'card_use', at: new Date('2026-10-31T12:00:00.000Z'), decision: 'approved', siteDomain: 'aircanada.com', amount: 'CA$412.30' },
          { kind: 'read', at: new Date('2026-10-30T12:00:00.000Z'), agentId: 'travel', toolName: 'browser-fill', source: 'vault', byReference: true, secretField: 'expiry_mm' },
        ],
      };
      app = await build(fakeSecrets(), fakeRegistry([]), { usage });
      const res = await app.inject({ method: 'GET', url: `/api/vault/secrets/${CARD_KEY}/uses`, headers: auth });
      expect(res.json()).toEqual({
        uses: [
          { kind: 'card_use', at: '2026-10-31T12:00:00.000Z', decision: 'approved', siteDomain: 'aircanada.com', amount: 'CA$412.30' },
          { kind: 'read', at: '2026-10-30T12:00:00.000Z', agentId: 'travel', toolName: 'browser-fill', source: 'vault', byReference: true, secretField: 'expiry_mm' },
        ],
      });
    });
  });

  it('new routes require auth', async () => {
    const secrets = fakeSecrets(['user.rogers_password']);
    app = await build(secrets, fakeRegistry());
    const body = { type: 'other', label: 'x', value: 'v' };
    expect((await app.inject({ method: 'POST', url: '/api/vault/user-secrets', payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/vault/user-secrets/preview', payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: '/api/vault/user-secrets/user.rogers_password', payload: { value: 'v' } })).statusCode).toBe(401);
    expect(secrets.sets).toEqual([]);
  });
});
