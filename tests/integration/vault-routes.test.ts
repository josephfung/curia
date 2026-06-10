// End-to-end-ish test of the vault routes via a real Fastify instance + SecretsService
// over a real Postgres vault. Requires DATABASE_URL + SECRET_ENCRYPTION_KEY-equivalent key.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { vaultRoutes } from '../../src/channels/http/routes/vault.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { RegistryService } from '../../src/registry/registry-service.js';
import { RegistryRepo } from '../../src/registry/registry-repo.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;
const SECRET = 'test-bootstrap-secret';
const KEY = randomBytes(32);
const logger = pino({ level: 'silent' });
const hdr = { 'x-web-bootstrap-secret': SECRET };
// Suite-unique key namespace. Deliberately NOT a canonical secret name (e.g. tavily_api_key)
// so a shared/persistent DATABASE_URL can't have a real configured key overwritten, and so
// cleanup only ever touches this suite's own rows (no race with other integration suites
// that use a 'test_%' prefix).
const DECLARED_KEY = 'vault_rt_declared_key';

describeIf('vault routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM secrets LIMIT 0'); // sanity: migration applied

    const secretsService = new SecretsService(pool, KEY, logger);
    // Registry seeded with one skill that declares a required secret, so the write
    // endpoint's scope guard has a known-allowed key ('tavily_api_key') and a
    // known-disallowed one (anything else).
    const registryService = new RegistryService(
      new RegistryRepo(pool, 'skill_registry'),
      new RegistryRepo(pool, 'agent_registry'),
      [{ name: 'web-search', metadata: { name: 'web-search', description: 'd', version: '1.0.0', requiresSecrets: [DECLARED_KEY] } }],
      [],
      secretsService,
    );

    const sessions: Map<string, number> = new Map();
    app = Fastify();
    await app.register(cookie);
    await app.register(vaultRoutes, { secretsService, registryService, webAppBootstrapSecret: SECRET, sessions });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    // Scope cleanup to this suite's own namespace only — never the shared 'test_%' prefix.
    await pool.query("DELETE FROM secrets WHERE name LIKE 'vault_rt_%'");
  });

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/vault/status' });
    expect(res.statusCode).toBe(401);
  });

  it('status lists configured key names', async () => {
    await app.inject({ method: 'PUT', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr, payload: { value: 'tok-xyz' } });
    const res = await app.inject({ method: 'GET', url: '/api/vault/status', headers: hdr });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { configured_keys: string[] };
    expect(body.configured_keys).toContain(DECLARED_KEY);
    // The value must never appear in the status response.
    expect(JSON.stringify(body)).not.toContain('tok-xyz');
  });

  it('sets a declared secret and persists it', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr, payload: { value: 'tok-abc' } });
    expect(res.statusCode).toBe(200);
    const svc = new SecretsService(pool, KEY, logger);
    expect(await svc.get(DECLARED_KEY)).toBe('tok-abc');
  });

  it('rejects setting a secret no skill declares', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/vault/secrets/vault_rt_undeclared', headers: hdr, payload: { value: 'x' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/not a required secret/);
    // Nothing was written.
    expect(await new SecretsService(pool, KEY, logger).get('vault_rt_undeclared')).toBeNull();
  });

  it('rejects an empty value', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr, payload: { value: '' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/non-empty/);
  });

  it('rejects an oversized value', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr, payload: { value: 'x'.repeat(8193) } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/exceeds/);
  });
});
