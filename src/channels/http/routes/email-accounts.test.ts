// email-accounts.test.ts — exercises the email-accounts HTTP CRUD routes against fake
// services. Auth is satisfied via the x-web-bootstrap-secret header path of assertSecret
// (same pattern as channel-registry.test.ts); sessions is a real empty Map per SessionStore.
//
// Covers:
//   GET /api/registry/email-accounts        — list with hasGrant derived from secrets.get
//   POST /api/registry/email-accounts       — create row + write grant; validate name + inputs
//   PATCH /api/registry/email-accounts/:name — update row; re-write grant when provided
//   DELETE /api/registry/email-accounts/:name — remove row + delete grant key
//   All routes 401 without a valid session/bootstrap secret
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { emailAccountsRoutes, type EmailAccountsRouteOptions } from './email-accounts.js';
import type { EmailAccountRow } from '../../email/email-accounts-repo.js';

const BOOTSTRAP = 'test-bootstrap-secret';
const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

// ---------- fake repo ----------

interface FakeRepo {
  list(): Promise<EmailAccountRow[]>;
  get(name: string): Promise<EmailAccountRow | null>;
  create(input: { name: string; selfEmail: string; provider?: string; createdBy?: string }): Promise<EmailAccountRow>;
  update(name: string, patch: { selfEmail?: string; enabled?: boolean }): Promise<EmailAccountRow | null>;
  delete(name: string): Promise<boolean>;
}

// Track calls so tests can assert repo interactions without a real DB.
interface RecordingRepo extends FakeRepo {
  createCalls: Array<{ name: string; selfEmail: string; provider?: string }>;
  updateCalls: Array<{ name: string; patch: { selfEmail?: string; enabled?: boolean } }>;
  deleteCalls: string[];
}

function makeAccount(overrides: Partial<EmailAccountRow> = {}): EmailAccountRow {
  return {
    name: 'main',
    selfEmail: 'main@example.com',
    provider: 'nylas',
    enabled: true,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    createdBy: 'web-console',
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeRepo(overrides: Partial<RecordingRepo> = {}): RecordingRepo {
  const createCalls: RecordingRepo['createCalls'] = [];
  const updateCalls: RecordingRepo['updateCalls'] = [];
  const deleteCalls: string[] = [];

  const base: RecordingRepo = {
    createCalls,
    updateCalls,
    deleteCalls,
    list: async () => [makeAccount()],
    get: async () => null,
    create: async (input) => {
      createCalls.push({ name: input.name, selfEmail: input.selfEmail, provider: input.provider });
      return makeAccount({ name: input.name, selfEmail: input.selfEmail });
    },
    update: async (name, patch) => {
      updateCalls.push({ name, patch });
      return makeAccount({ name });
    },
    delete: async (name) => {
      deleteCalls.push(name);
      return true;
    },
    ...overrides,
  };
  return base;
}

// ---------- fake secrets ----------

interface RecordingSecrets {
  sets: Array<{ name: string; value: string }>;
  deletes: string[];
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

function fakeSecrets(grantMap: Record<string, string> = {}): RecordingSecrets {
  const sets: Array<{ name: string; value: string }> = [];
  const deletes: string[] = [];
  return {
    sets,
    deletes,
    get: async (name) => grantMap[name] ?? null,
    set: async (name, value) => { sets.push({ name, value }); },
    delete: async (name) => { deletes.push(name); },
  };
}

// ---------- test harness ----------

async function build(
  repo: FakeRepo,
  secrets: RecordingSecrets,
): Promise<FastifyInstance> {
  const app = Fastify();
  const options: EmailAccountsRouteOptions = {
    // EmailAccountsRepo is constructed inside the route module from the pool,
    // but in tests we inject the repo via the repoFactory override. Because
    // the route module creates `new EmailAccountsRepo(pool)` internally, we
    // need to pass a pool object. However, since the test-level fake repo
    // controls all DB calls, the pool is never actually used — we pass a
    // sentinel that satisfies the type requirement only.
    //
    // The route module accepts an optional `repoForTest` injection for tests.
    pool: {} as import('pg').Pool,
    secretsService: secrets,
    webAppBootstrapSecret: BOOTSTRAP,
    sessions: new Map(),
    repoForTest: repo as import('../../email/email-accounts-repo.js').EmailAccountsRepo,
  };
  await app.register(emailAccountsRoutes, options);
  return app;
}

// ---------- tests ----------

describe('email-accounts routes', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  // --- GET ---

  it('GET /api/registry/email-accounts returns accounts with hasGrant=true when grant exists', async () => {
    const repo = fakeRepo();
    // The account named 'main' has a grant in the vault.
    const secrets = fakeSecrets({ 'channel.email.main.nylas_grant_id': 'grant_abc' });
    app = await build(repo, secrets);
    const res = await app.inject({ method: 'GET', url: '/api/registry/email-accounts', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accounts: Array<{ name: string; hasGrant: boolean }> };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]!.name).toBe('main');
    expect(body.accounts[0]!.hasGrant).toBe(true);
    // Value must never be included in the response.
    expect(JSON.stringify(body)).not.toContain('grant_abc');
  });

  it('GET returns hasGrant=false when grant is absent', async () => {
    const repo = fakeRepo();
    const secrets = fakeSecrets(); // no grants in vault
    app = await build(repo, secrets);
    const res = await app.inject({ method: 'GET', url: '/api/registry/email-accounts', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accounts: Array<{ hasGrant: boolean }> };
    expect(body.accounts[0]!.hasGrant).toBe(false);
  });

  // --- POST ---

  it('POST with valid body creates the row and writes the grant', async () => {
    // repo.get returns null (no duplicate), so creation proceeds.
    const repo = fakeRepo({ get: async () => null });
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/email-accounts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'main', selfEmail: 'main@example.com', grantId: 'grant_xyz' },
    });
    expect(res.statusCode).toBe(201);
    // Grant written to vault before row created.
    expect(secrets.sets).toEqual([{ name: 'channel.email.main.nylas_grant_id', value: 'grant_xyz' }]);
    expect(repo.createCalls).toHaveLength(1);
    expect(repo.createCalls[0]!.name).toBe('main');
    // hasGrant in response must be true, value must not leak.
    const body = res.json() as { account: { hasGrant: boolean } };
    expect(body.account.hasGrant).toBe(true);
    expect(JSON.stringify(body)).not.toContain('grant_xyz');
  });

  it('POST with invalid name (contains uppercase) returns 400, repo.create NOT called', async () => {
    const repo = fakeRepo();
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/email-accounts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'Bad.Name', selfEmail: 'x@example.com', grantId: 'grant_abc' },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.createCalls).toHaveLength(0);
    expect(secrets.sets).toHaveLength(0);
  });

  it('POST with invalid name (empty) returns 400', async () => {
    const repo = fakeRepo();
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/email-accounts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: '', selfEmail: 'x@example.com', grantId: 'grant_abc' },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.createCalls).toHaveLength(0);
  });

  it('POST missing selfEmail returns 400', async () => {
    const repo = fakeRepo();
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/email-accounts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'main', grantId: 'grant_abc' },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.createCalls).toHaveLength(0);
  });

  it('POST missing grantId returns 400', async () => {
    const repo = fakeRepo();
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/email-accounts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'main', selfEmail: 'x@example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.createCalls).toHaveLength(0);
  });

  it('POST with unsupported provider returns 400', async () => {
    const repo = fakeRepo({ get: async () => null });
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/email-accounts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'main', selfEmail: 'x@example.com', grantId: 'g', provider: 'gmail-direct' },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.createCalls).toHaveLength(0);
  });

  it('POST duplicate name returns 409', async () => {
    // repo.get returns an existing row → duplicate detection before any write.
    const existing = makeAccount({ name: 'main' });
    const repo = fakeRepo({ get: async () => existing });
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/email-accounts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'main', selfEmail: 'main@example.com', grantId: 'grant_xyz' },
    });
    expect(res.statusCode).toBe(409);
    expect(repo.createCalls).toHaveLength(0);
    expect(secrets.sets).toHaveLength(0);
  });

  // --- PATCH ---

  it('PATCH updates selfEmail and re-writes the grant when grantId is provided', async () => {
    const existing = makeAccount({ name: 'main' });
    const repo = fakeRepo({ get: async () => existing });
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/registry/email-accounts/main',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { selfEmail: 'new@example.com', grantId: 'new_grant' },
    });
    expect(res.statusCode).toBe(200);
    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0]!.patch.selfEmail).toBe('new@example.com');
    // Grant key re-written in vault.
    expect(secrets.sets).toEqual([{ name: 'channel.email.main.nylas_grant_id', value: 'new_grant' }]);
  });

  it('PATCH updates enabled without touching the grant when grantId is absent', async () => {
    const existing = makeAccount({ name: 'main' });
    const repo = fakeRepo({ get: async () => existing });
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/registry/email-accounts/main',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(repo.updateCalls[0]!.patch.enabled).toBe(false);
    expect(secrets.sets).toHaveLength(0);
  });

  it('PATCH returns 404 when account does not exist', async () => {
    const repo = fakeRepo({ get: async () => null });
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/registry/email-accounts/nonexistent',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(repo.updateCalls).toHaveLength(0);
  });

  // --- DELETE ---

  it('DELETE removes the row and deletes the grant key', async () => {
    const existing = makeAccount({ name: 'main' });
    const repo = fakeRepo({
      get: async () => existing,
      delete: async (name) => {
        repo.deleteCalls.push(name);
        return true;
      },
    });
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/registry/email-accounts/main',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(repo.deleteCalls).toContain('main');
    expect(secrets.deletes).toContain('channel.email.main.nylas_grant_id');
  });

  it('DELETE returns 404 when account does not exist', async () => {
    const repo = fakeRepo({ delete: async () => false });
    const secrets = fakeSecrets();
    app = await build(repo, secrets);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/registry/email-accounts/nonexistent',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(secrets.deletes).toHaveLength(0);
  });

  // --- Auth ---

  it('GET returns 401 without authentication', async () => {
    app = await build(fakeRepo(), fakeSecrets());
    const res = await app.inject({ method: 'GET', url: '/api/registry/email-accounts' });
    expect(res.statusCode).toBe(401);
  });

  it('POST returns 401 without authentication', async () => {
    app = await build(fakeRepo(), fakeSecrets());
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/email-accounts',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'main', selfEmail: 'x@example.com', grantId: 'g' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('PATCH returns 401 without authentication', async () => {
    app = await build(fakeRepo(), fakeSecrets());
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/registry/email-accounts/main',
      headers: { 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE returns 401 without authentication', async () => {
    app = await build(fakeRepo(), fakeSecrets());
    const res = await app.inject({ method: 'DELETE', url: '/api/registry/email-accounts/main' });
    expect(res.statusCode).toBe(401);
  });
});
