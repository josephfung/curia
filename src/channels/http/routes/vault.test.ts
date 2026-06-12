// vault.test.ts — exercises the secrets-vault HTTP routes against fake services.
// Auth is satisfied via the x-web-bootstrap-secret header path of assertSecret (same
// pattern as channel-registry.test.ts); sessions is a real empty Map per SessionStore.
//
// The scope guard on PUT /api/vault/secrets/:name accepts a name only if it is EITHER a
// skill-declared secret OR a valid channel credential key from CHANNEL_CATALOG. These tests
// prove both accept paths and the reject paths (arbitrary names and bogus channel keys).
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { vaultRoutes, type VaultSecretsPort } from './vault.js';
import type { RegistryService } from '../../../registry/registry-service.js';

const BOOTSTRAP = 'test-bootstrap-secret';

// A skill-declared secret used to prove the original scope-guard path still works.
const DECLARED_SECRET = 'some_skill_secret';

/** Records set() calls so tests can assert the secret was actually written. */
interface RecordingSecrets extends VaultSecretsPort {
  sets: Array<{ name: string; value: string }>;
}

function fakeSecrets(): RecordingSecrets {
  const sets: Array<{ name: string; value: string }> = [];
  return {
    sets,
    list: async () => sets.map(s => s.name),
    set: async (name: string, value: string) => {
      sets.push({ name, value });
    },
  };
}

// Minimal RegistryService fake — only declaredSecretNames() is called by these routes.
function fakeRegistry(declared: string[] = [DECLARED_SECRET]): RegistryService {
  const base: Partial<RegistryService> = {
    declaredSecretNames: () => declared,
  };
  return base as RegistryService;
}

async function build(
  secretsService: VaultSecretsPort,
  registryService: RegistryService,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(vaultRoutes, {
    secretsService,
    registryService,
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
});
