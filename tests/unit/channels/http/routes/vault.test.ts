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
import type { SecretUsagePort } from '../../../../../src/secrets/secret-usage-repo.js';

const BOOTSTRAP = 'test-bootstrap-secret';

// A skill-declared secret used to prove the original scope-guard path still works.
const DECLARED_SECRET = 'some_skill_secret';

/** Records set() calls so tests can assert the secret was actually written. */
interface RecordingSecrets extends VaultSecretsPort {
  sets: Array<{ name: string; value: string }>;
  deletes: string[];
}

const CREATED = new Date('2026-09-01T00:00:00.000Z');
const UPDATED = new Date('2026-10-02T00:00:00.000Z');

function fakeSecrets(preset: string[] = [], details: Record<string, UserSecretDetails> = {}): RecordingSecrets {
  const sets: Array<{ name: string; value: string }> = [];
  const deletes: string[] = [];
  const present = new Set(preset);
  return {
    sets,
    deletes,
    list: async () => [...present],
    listMetadata: async () => [...present].map(name => ({ name, valueFormat: 'string' as const, createdAt: CREATED, updatedAt: UPDATED })),
    listUserNames: async () => [...present].filter(n => n.startsWith('user.')),
    listUserDetails: async () => new Map(Object.entries(details)),
    upsertUserDetails: async () => {},
    patchUserDetails: async () => {},
    deleteUserDetails: async () => {},
    set: async (name: string, value: string) => {
      sets.push({ name, value });
      present.add(name);
    },
    delete: async (name: string) => {
      deletes.push(name);
      present.delete(name);
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
  extra: { usage?: SecretUsagePort; bus?: EventBus; mcp?: McpRegistryService; channels?: ChannelRegistryService; emailAccounts?: Array<{ name: string; enabled: boolean }> } = {},
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
  ])('accepts the principal-mailbox key %s', async (name, value) => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
    const res = await put(app, name, { value });
    expect(res.statusCode).toBe(200);
    expect(secrets.sets).toEqual([{ name, value }]);
  });

  // The address is the reply-all self-filter; a non-address would filter nothing.
  it.each(['not-an-address', 'a@b', 'two words@example.com'])('rejects ceo_self_email %j', async value => {
    const secrets = fakeSecrets();
    app = await build(secrets, fakeRegistry());
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

  it('PUT and DELETE reject the same unknown names', async () => {
    const secrets = fakeSecrets(['random_key', 'channel.email.not_a_field']);
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

  it('refuses to delete the principal calendar grant, but not the optional address', async () => {
    const secrets = fakeSecrets(['ceo_nylas_grant_id', 'ceo_self_email']);
    app = await build(secrets, fakeRegistry());
    const refused = await del(app, 'ceo_nylas_grant_id');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('Calendar and principal inbox');
    expect((await del(app, 'ceo_self_email')).statusCode).toBe(200);
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
    expect(byName.get('ceo_self_email')).toMatchObject({ configured: false, required: false });
    expect(byName.get('ceo_nylas_grant_id')).toMatchObject({ configured: false, required: true });
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
        lastUsedByName: async () => new Map([['user.rogers_password', new Date('2026-10-01T00:00:00.000Z')]]),
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
});
