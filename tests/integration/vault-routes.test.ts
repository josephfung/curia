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
import { EventBus } from '../../src/bus/bus.js';
import { AuditLogger } from '../../src/audit/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

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
// Personal keys live under user.*; the suite's own are user.vault_rt_*.
const PERSONAL_LABEL = 'vault_rt personal code';
const PERSONAL_KEY = 'user.vault_rt_personal_code';

describeIf('vault routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Before any write: audit_log is append-only, so rows written to the wrong database stay.
    await requireCuriaTestDatabase(pool);
    await pool.query('SELECT 1 FROM secrets LIMIT 0'); // sanity: migration applied

    const secretsService = new SecretsService(pool, KEY, logger);
    // Registry seeded with one skill that declares a required secret, so the write
    // endpoint's scope guard has a known-allowed key ('tavily_api_key') and a
    // known-disallowed one (anything else).
    const registryService = new RegistryService(
      new RegistryRepo(pool, 'tool_registry'),
      new RegistryRepo(pool, 'agent_registry'),
      [{ name: 'web-search', metadata: { name: 'web-search', description: 'd', version: '1.0.0', requiresSecrets: [DECLARED_KEY] } }],
      [],
      secretsService,
    );

    const sessions = new Map<string, { id: string; expiresAt: number; renewedAt: number }>();
    app = Fastify();
    await app.register(cookie);
    // The real write-ahead audit hook, as in production: a set or delete must leave
    // secret.changed rows in audit_log, not just a resolved publish.
    const auditLogger = new AuditLogger(pool, logger);
    const bus = new EventBus(logger, (e) => auditLogger.log(e), (id) => auditLogger.markAcknowledged(id));
    await app.register(vaultRoutes, { secretsService, registryService, bus, webAppBootstrapSecret: SECRET, sessions });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    // Scope cleanup to this suite's own namespace only — never the shared 'test_%' prefix.
    await pool.query("DELETE FROM secrets WHERE name LIKE 'vault_rt_%' OR name LIKE 'user.vault_rt_%'");
    await pool.query("DELETE FROM user_secret_details WHERE name LIKE 'user.vault_rt_%'");
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
    expect((res.json() as { error: string }).error).toMatch(/not a secret declared/);
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

  it('writes secret.changed audit rows for a set and a delete, by key name only', async () => {
    const since = new Date();
    await app.inject({ method: 'PUT', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr, payload: { value: 'tok-audited' } });
    await app.inject({ method: 'DELETE', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr });
    const { rows } = await pool.query<{ action: string; outcome: string; initiator_id: string; payload: string }>(
      `SELECT action, outcome, initiator_id, payload::text AS payload FROM audit_log
        WHERE event_type = 'secret.changed' AND target_id = $1 AND timestamp >= $2
        ORDER BY timestamp, seq`,
      [DECLARED_KEY, since],
    );
    expect(rows.map(r => `${r.action}:${r.outcome}`)).toEqual(['set:pending', 'set:success', 'delete:pending', 'delete:success']);
    expect(rows.every(r => r.initiator_id === 'bootstrap_secret')).toBe(true);
    expect(rows.map(r => r.payload).join()).not.toContain('tok-audited');
  });

  // After a delete the vault returns null. The execution layer re-reads declared secrets on
  // every call, and tests/unit/skills/web-search-keyless-caller.test.ts shows a null read
  // makes web-search run keyless.
  it('deletes a secret from the real vault, idempotently', async () => {
    const svc = new SecretsService(pool, KEY, logger);
    await app.inject({ method: 'PUT', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr, payload: { value: 'tok-del' } });
    expect(await svc.get(DECLARED_KEY)).toBe('tok-del');

    // 'web-search' is not enabled in this registry (no row), so the delete is not blocked.
    const res = await app.inject({ method: 'DELETE', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, removed: true });
    expect(await svc.get(DECLARED_KEY)).toBeNull();

    const again = await app.inject({ method: 'DELETE', url: `/api/vault/secrets/${DECLARED_KEY}`, headers: hdr });
    expect(again.json()).toEqual({ ok: true, removed: false });
  });

  it('rejects deleting a name neither declared nor in the vault', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/vault/secrets/vault_rt_undeclared', headers: hdr });
    expect(res.statusCode).toBe(400);
  });

  it('deletes an orphaned key that no skill declares', async () => {
    const svc = new SecretsService(pool, KEY, logger);
    await svc.set('vault_rt_orphan', 'stale');
    const res = await app.inject({ method: 'DELETE', url: '/api/vault/secrets/vault_rt_orphan', headers: hdr });
    expect(res.statusCode).toBe(200);
    expect(await svc.get('vault_rt_orphan')).toBeNull();
  });

  it('creates a personal secret with details, audited as a two-stage set, and deletes both', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/vault/user-secrets', headers: hdr,
      payload: { type: 'other', label: PERSONAL_LABEL, username: 'vault-rt-user', value: 'pw-personal-rt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: PERSONAL_KEY, replaced: false });
    expect(res.body).not.toContain('pw-personal-rt');

    const svc = new SecretsService(pool, KEY, logger);
    expect(await svc.get(PERSONAL_KEY)).toBe('pw-personal-rt');
    expect((await svc.listUserDetails()).get(PERSONAL_KEY)).toEqual({ username: 'vault-rt-user' });

    // audit_log is append-only, so earlier runs' rows for this name stay: read the newest two.
    const { rows } = await pool.query<{ event_type: string; action: string; stage: string; payload: string }>(
      `SELECT event_type, payload->>'action' AS action, payload->>'stage' AS stage, payload::text AS payload
         FROM audit_log WHERE payload->>'secretName' = $1
        ORDER BY timestamp DESC, seq DESC LIMIT 2`,
      [PERSONAL_KEY],
    );
    expect(rows.reverse().map(r => `${r.event_type}:${r.action}:${r.stage}`)).toEqual([
      'secret.changed:set:requested', 'secret.changed:set:completed',
    ]);
    expect(rows.map(r => r.payload).join()).not.toContain('pw-personal-rt');

    const del = await app.inject({ method: 'DELETE', url: `/api/vault/secrets/${encodeURIComponent(PERSONAL_KEY)}`, headers: hdr });
    expect(del.statusCode).toBe(200);
    expect(await svc.get(PERSONAL_KEY)).toBeNull();
    expect((await svc.listUserDetails()).has(PERSONAL_KEY)).toBe(false);
  });
});
