import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { loadEncryptionKey } from '../../src/secrets/crypto.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { seedVault, verifyRequiredSecrets, parseSeedOnly, parseSeedRequire, SEED_SECRET_NAMES, SEED_IF_ABSENT_NAMES, REQUIRED_SECRET_NAMES } from '../../scripts/seed-vault.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL && process.env.SECRET_ENCRYPTION_KEY ? describe : describe.skip;
const NYLAS_KEY = 'channel.email.nylas_api_key';
const LIVEKIT_ENV = {
  SEED_LIVEKIT_URL: 'wss://curia.example.com',
  SEED_LIVEKIT_API_KEY: 'lk-key-new',
  SEED_LIVEKIT_API_SECRET: 'lk-secret-new',
};

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
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[...SEED_SECRET_NAMES, ...SEED_IF_ABSENT_NAMES]]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[...SEED_SECRET_NAMES, ...SEED_IF_ABSENT_NAMES]]);
    await pool.end();
  });

  it('does not seed the legacy signal_phone_number key (consolidated to channel.signal.phone_number, #1140)', async () => {
    expect([...SEED_SECRET_NAMES]).not.toContain('signal_phone_number');
    const { seeded, skipped } = await seedVault(secrets, { SIGNAL_PHONE_NUMBER: '+12223334444' }, logger);
    expect(seeded).not.toContain('signal_phone_number');
    expect(skipped).not.toContain('signal_phone_number');
    expect(await secrets.get('signal_phone_number')).toBeNull();
  });

  it('seeds NYLAS_API_KEY under the canonical channel key, never the retired flat names (#2522)', async () => {
    for (const legacy of ['nylas_api_key', 'nylas_grant_id', 'nylas_self_email']) {
      expect([...SEED_SECRET_NAMES]).not.toContain(legacy);
    }
    const env = { NYLAS_API_KEY: 'nyk_test_123', NYLAS_GRANT_ID: 'grant', NYLAS_SELF_EMAIL: 'curia@example.com' };
    const { seeded } = await seedVault(secrets, env, logger);
    expect(seeded).toEqual([NYLAS_KEY]);
    expect(await secrets.get(NYLAS_KEY)).toBe('nyk_test_123');
  });

  it('skips the flat principal-mailbox keys once the console manages them (#2475)', async () => {
    const env = { CEO_NYLAS_GRANT_ID: 'grant-from-env', CEO_SELF_EMAIL: 'boss@example.com', TAVILY_API_KEY: 'tvly_1' };
    const managed = await seedVault(secrets, env, logger, { flatKeysManaged: async () => true });
    expect(managed.seeded).toEqual(['tavily_api_key']);
    expect(managed.skipped).toEqual(expect.arrayContaining(['ceo_nylas_grant_id', 'ceo_self_email']));
    expect(await secrets.get('ceo_nylas_grant_id')).toBeNull();

    const unmanaged = await seedVault(secrets, env, logger, { flatKeysManaged: async () => false });
    expect(unmanaged.seeded).toEqual(expect.arrayContaining(['ceo_nylas_grant_id', 'ceo_self_email']));
    expect(await secrets.get('ceo_nylas_grant_id')).toBe('grant-from-env');
  });

  it('seeds present env values into the vault and skips absent ones', async () => {
    const env = { NYLAS_API_KEY: 'nyk_test_123', TAVILY_API_KEY: 'tvly_test_456' };
    const { seeded, skipped } = await seedVault(secrets, env, logger);

    expect(seeded.sort()).toEqual([NYLAS_KEY, 'tavily_api_key']);
    expect(skipped).toContain('anthropic_api_key');
    expect(await secrets.get(NYLAS_KEY)).toBe('nyk_test_123');
    expect(await secrets.get('tavily_api_key')).toBe('tvly_test_456');
    expect(await secrets.get('anthropic_api_key')).toBeNull();
  });

  it('seeds only the names in `only`, leaving other present values alone', async () => {
    const env = { NYLAS_API_KEY: 'nyk_test_123', OPENROUTER_API_KEY: 'sk-or-test' };
    const { seeded } = await seedVault(secrets, env, logger, { only: new Set(['openrouter_api_key']) });
    expect(seeded).toEqual(['openrouter_api_key']);
    expect(await secrets.get('openrouter_api_key')).toBe('sk-or-test');
    expect(await secrets.get(NYLAS_KEY)).toBeNull();
  });

  it('treats empty-string env values as absent (skipped)', async () => {
    const { seeded, skipped } = await seedVault(secrets, { NYLAS_API_KEY: '' }, logger);
    expect(seeded).not.toContain(NYLAS_KEY);
    expect(skipped).toContain(NYLAS_KEY);
  });

  it('treats whitespace-only env values as absent (skipped)', async () => {
    const { seeded, skipped } = await seedVault(secrets, { NYLAS_API_KEY: '   ' }, logger);
    expect(seeded).not.toContain(NYLAS_KEY);
    expect(skipped).toContain(NYLAS_KEY);
    expect(await secrets.get(NYLAS_KEY)).toBeNull();
  });

  it('trims surrounding whitespace from seeded values (copy-paste artifacts)', async () => {
    await seedVault(secrets, { TAVILY_API_KEY: '  tvly_padded_123\n' }, logger);
    expect(await secrets.get('tavily_api_key')).toBe('tvly_padded_123');
  });

  it('verifyRequiredSecrets treats a whitespace-only required secret as missing', async () => {
    await seedVault(
      secrets,
      { ANTHROPIC_API_KEY: 'sk-ant-x', API_TOKEN: 'tok-x', WEB_APP_BOOTSTRAP_SECRET: 'wabs-x' },
      logger,
    );
    // A whitespace-only row would pass a bare null-check but disables HTTP auth, so it
    // must be reported missing — set it directly (the seeder would have skipped it).
    await secrets.set('api_token', '   ');
    expect(await verifyRequiredSecrets(secrets, logger)).toEqual(['api_token']);
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

  it('verifyRequiredSecrets also checks the extra names it is given (#2749)', async () => {
    await seedVault(secrets, { API_TOKEN: 'tok-x', WEB_APP_BOOTSTRAP_SECRET: 'wabs-x', AWS_ACCESS_KEY_ID: 'AKIAX' }, logger);
    const extra = new Set(['aws_access_key_id', 'aws_secret_access_key']);
    expect(await verifyRequiredSecrets(secrets, logger, extra)).toEqual(['aws_secret_access_key']);
    // A name already in the base list is checked once.
    expect(await verifyRequiredSecrets(secrets, logger, new Set(['api_token']))).toEqual([]);
  });

  it('writes the LiveKit values when the vault has none', async () => {
    const { seeded } = await seedVault(secrets, LIVEKIT_ENV, logger);
    expect(seeded).toEqual(expect.arrayContaining([...SEED_IF_ABSENT_NAMES]));
    expect(await secrets.get('channel.voice.livekit_url')).toBe('wss://curia.example.com');
    expect(await secrets.get('channel.voice.livekit_api_key')).toBe('lk-key-new');
    expect(await secrets.get('channel.voice.livekit_api_secret')).toBe('lk-secret-new');
  });

  it('never overwrites LiveKit values already in the vault', async () => {
    await secrets.set('channel.voice.livekit_url', 'old-url');
    await secrets.set('channel.voice.livekit_api_key', 'old-key');
    await secrets.set('channel.voice.livekit_api_secret', 'old-secret');
    const { seeded, kept } = await seedVault(secrets, LIVEKIT_ENV, logger);
    expect(await secrets.get('channel.voice.livekit_url')).toBe('old-url');
    expect(await secrets.get('channel.voice.livekit_api_key')).toBe('old-key');
    expect(await secrets.get('channel.voice.livekit_api_secret')).toBe('old-secret');
    expect([...kept].sort()).toEqual([...SEED_IF_ABSENT_NAMES].sort());
    for (const name of SEED_IF_ABSENT_NAMES) expect(seeded).not.toContain(name);
  });

  it('reports kept values that differ from the offered ones, and warns without printing keys', async () => {
    const logs: Array<{ level: number; obj: Record<string, unknown>; msg: string }> = [];
    const spyLogger = pino({ level: 'info' }, {
      write: (line: string) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        logs.push({ level: parsed.level as number, obj: parsed, msg: String(parsed.msg) });
      },
    });
    await secrets.set('channel.voice.livekit_url', 'wss://old.example.com');
    await secrets.set('channel.voice.livekit_api_key', 'old-key');
    // Same secret as offered: kept, but not a difference.
    await secrets.set('channel.voice.livekit_api_secret', 'lk-secret-new');
    const { kept, keptDiffers } = await seedVault(secrets, LIVEKIT_ENV, spyLogger);
    expect([...kept].sort()).toEqual([...SEED_IF_ABSENT_NAMES].sort());
    expect([...keptDiffers].sort()).toEqual(['channel.voice.livekit_api_key', 'channel.voice.livekit_url']);
    const warns = logs.filter(l => l.level === 40);
    expect(warns.map(w => w.obj.name).sort()).toEqual(['channel.voice.livekit_api_key', 'channel.voice.livekit_url']);
    const all = JSON.stringify(logs);
    // The URL is not a secret and is named so the operator can see what was kept.
    expect(all).toContain('wss://old.example.com');
    expect(all).toContain('wss://curia.example.com');
    // Keys and secrets never appear, kept or offered.
    for (const v of ['old-key', 'lk-key-new', 'lk-secret-new']) expect(all).not.toContain(v);
  });

  it('keptDiffers is empty when the vault already holds the offered values', async () => {
    await seedVault(secrets, LIVEKIT_ENV, logger);
    const { kept, keptDiffers } = await seedVault(secrets, LIVEKIT_ENV, logger);
    expect(kept).toHaveLength(SEED_IF_ABSENT_NAMES.length);
    expect(keptDiffers).toEqual([]);
  });

  it('still upserts ordinary secrets', async () => {
    await secrets.set('api_token', 'old');
    await seedVault(secrets, { API_TOKEN: 'new' }, logger);
    expect(await secrets.get('api_token')).toBe('new');
  });
});

describe('parseSeedOnly', () => {
  it('accepts channel.voice.livekit_url', () => {
    expect([...parseSeedOnly('channel.voice.livekit_url')!]).toEqual(['channel.voice.livekit_url']);
  });

  it('is undefined when unset or blank', () => {
    expect(parseSeedOnly(undefined)).toBeUndefined();
    expect(parseSeedOnly('  ')).toBeUndefined();
  });

  it('parses a comma list of known names', () => {
    expect([...parseSeedOnly('openrouter_api_key, openai_api_key')!]).toEqual(['openrouter_api_key', 'openai_api_key']);
  });

  it('accepts the canonical Nylas key and rejects the retired flat name', () => {
    expect([...parseSeedOnly('channel.email.nylas_api_key')!]).toEqual(['channel.email.nylas_api_key']);
    expect(() => parseSeedOnly('nylas_api_key')).toThrow(/unknown secret/);
  });

  it('rejects an unknown name instead of seeding nothing', () => {
    expect(() => parseSeedOnly('openrouter_key')).toThrow(/unknown secret\(s\): openrouter_key/);
  });
});

describe('parseSeedRequire', () => {
  it('is empty when unset or blank', () => {
    expect([...parseSeedRequire(undefined)]).toEqual([]);
    expect([...parseSeedRequire(' ')]).toEqual([]);
  });

  it('parses the provider keys the installers pass', () => {
    expect([...parseSeedRequire('aws_access_key_id,aws_secret_access_key')]).toEqual(['aws_access_key_id', 'aws_secret_access_key']);
  });

  it('rejects an unknown name instead of checking nothing', () => {
    expect(() => parseSeedRequire('openrouter_key')).toThrow(/SEED_VAULT_REQUIRE names unknown secret\(s\): openrouter_key/);
  });
});
