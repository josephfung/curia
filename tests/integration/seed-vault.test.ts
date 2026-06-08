import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { loadEncryptionKey } from '../../src/secrets/crypto.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { seedVault, verifyRequiredSecrets, SEED_SECRET_NAMES, REQUIRED_SECRET_NAMES } from '../../scripts/seed-vault.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL && process.env.SECRET_ENCRYPTION_KEY ? describe : describe.skip;

describeIf('seedVault', () => {
  const logger = pino({ level: 'silent' });
  // Construct pool/service inside hooks (not at describe-callback top level) so that
  // `describe.skip` can collect the suite without invoking loadEncryptionKey() — which
  // throws when SECRET_ENCRYPTION_KEY is unset. Mirrors secrets-service.test.ts.
  let pool: pg.Pool;
  let secrets: SecretsService;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    secrets = new SecretsService(pool, loadEncryptionKey(), logger);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[...SEED_SECRET_NAMES]]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[...SEED_SECRET_NAMES]]);
    await pool.end();
  });

  it('seeds present env values into the vault and skips absent ones', async () => {
    const env = { NYLAS_API_KEY: 'nyk_test_123', TAVILY_API_KEY: 'tvly_test_456' };
    const { seeded, skipped } = await seedVault(secrets, env, logger);

    expect(seeded.sort()).toEqual(['nylas_api_key', 'tavily_api_key']);
    expect(skipped).toContain('anthropic_api_key');
    expect(await secrets.get('nylas_api_key')).toBe('nyk_test_123');
    expect(await secrets.get('tavily_api_key')).toBe('tvly_test_456');
    expect(await secrets.get('anthropic_api_key')).toBeNull();
  });

  it('treats empty-string env values as absent (skipped)', async () => {
    const { seeded, skipped } = await seedVault(secrets, { NYLAS_API_KEY: '' }, logger);
    expect(seeded).not.toContain('nylas_api_key');
    expect(skipped).toContain('nylas_api_key');
  });

  it('is idempotent — re-running upserts the same value', async () => {
    await seedVault(secrets, { TAVILY_API_KEY: 'tvly_v1' }, logger);
    await seedVault(secrets, { TAVILY_API_KEY: 'tvly_v2' }, logger);
    expect(await secrets.get('tavily_api_key')).toBe('tvly_v2');
  });

  it('verifyRequiredSecrets reports every required secret missing from an empty vault', async () => {
    const missing = await verifyRequiredSecrets(secrets, logger);
    expect(missing.sort()).toEqual([...REQUIRED_SECRET_NAMES].sort());
  });

  it('verifyRequiredSecrets reports the specific required secret still missing after a partial seed', async () => {
    // Simulate the resume-path gap: anthropic + web_app_bootstrap_secret seeded, api_token never persisted.
    await seedVault(
      secrets,
      { ANTHROPIC_API_KEY: 'sk-ant-x', WEB_APP_BOOTSTRAP_SECRET: 'wabs-x' },
      logger,
    );
    const missing = await verifyRequiredSecrets(secrets, logger);
    expect(missing).toEqual(['api_token']);
  });

  it('verifyRequiredSecrets treats an empty-string required secret as missing', async () => {
    // An empty api_token row would pass a bare null-check but disables HTTP auth, so it
    // must be reported missing — set the other two so only the empty one is flagged.
    await seedVault(
      secrets,
      { ANTHROPIC_API_KEY: 'sk-ant-x', WEB_APP_BOOTSTRAP_SECRET: 'wabs-x' },
      logger,
    );
    await secrets.set('api_token', '');
    expect(await verifyRequiredSecrets(secrets, logger)).toEqual(['api_token']);
  });

  it('verifyRequiredSecrets returns empty when all required secrets are present', async () => {
    await seedVault(
      secrets,
      { ANTHROPIC_API_KEY: 'sk-ant-x', API_TOKEN: 'tok-x', WEB_APP_BOOTSTRAP_SECRET: 'wabs-x' },
      logger,
    );
    expect(await verifyRequiredSecrets(secrets, logger)).toEqual([]);
  });
});
