// seed-vault.ts — one-time / idempotent migration of plaintext env secrets into
// the encrypted vault (#911). The vault `set()` is an upsert, so re-running is safe.
//
// Run for a manual migration (reads the current .env):
//   pnpm run seed-vault
// Add a single secret later (transient env var, then run):
//   NYLAS_API_KEY=nyk_... pnpm run seed-vault
//
// Invoked by scripts/setup.sh after migrations for fresh installs.
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import pino from 'pino';
import { loadEncryptionKey } from '../src/secrets/crypto.js';
import { SecretsService } from '../src/secrets/secrets-service.js';

const logger = pino({ name: 'seed-vault' });

// Canonical list of secrets migrated into the vault (#911). Each vault key is
// snake_case; its env var is the UPPER_SNAKE_CASE form (the same name.toUpperCase()
// convention used by the execution layer's ctx.secret() and by applyVaultSecrets()).
// Order is irrelevant — set() is an upsert.
export const SEED_SECRET_NAMES = [
  // bootstrap/config-scoped (resolved at boot by applyVaultSecrets)
  'anthropic_api_key',
  'openai_api_key',
  'openrouter_api_key',
  'api_token',
  'web_app_bootstrap_secret',
  'nylas_api_key',
  'nylas_grant_id',
  'nylas_self_email',
  'signal_phone_number',
  // skill-scoped (resolved at call time by ctx.secret)
  'ceo_nylas_grant_id',
  'ceo_self_email',
  'tavily_api_key',
] as const;

// The subset of secrets that MUST exist in the vault for a working install. Their
// absence is not "feature off" — it's a broken deploy: anthropic_api_key powers all
// agents, api_token gates HTTP auth (a missing token disables auth entirely, see
// src/channels/http/auth.ts and the boot guard in src/index.ts), and
// web_app_bootstrap_secret gates web login. setup.sh runs verifyRequiredSecrets() after
// seeding so a partial/failed seed fails loudly instead of producing a half-configured
// (and possibly auth-disabled) install (#911).
export const REQUIRED_SECRET_NAMES = [
  'anthropic_api_key',
  'api_token',
  'web_app_bootstrap_secret',
] as const;

/**
 * Confirm each required secret has a row in the vault. Returns the names of any that are
 * missing so the caller can fail loudly. Reads via SecretsService.get, so a present-but-
 * undecryptable row surfaces as a thrown error rather than a false "present".
 */
export async function verifyRequiredSecrets(
  secrets: SecretsService,
  log: pino.Logger,
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of REQUIRED_SECRET_NAMES) {
    // Treat an empty value as missing, not present. An empty api_token would pass a bare
    // null-check but disables HTTP auth — validateBearerToken() treats "" as "no token
    // configured" — so an unusable vault state must fail loudly here, matching the
    // falsy-check boot guard in src/index.ts.
    const value = await secrets.get(name);
    if (value === null || value === '') missing.push(name);
  }
  if (missing.length > 0) {
    log.error({ missing }, 'Required secrets missing from vault');
  } else {
    log.info({ required: REQUIRED_SECRET_NAMES }, 'Required secrets present in vault');
  }
  return missing;
}

/**
 * Read each migrated secret from `env` (by its UPPER_SNAKE_CASE name) and upsert any
 * present, non-empty value into the vault. Absent/empty values are skipped, never
 * cleared — this is additive so a partial env (e.g. no Signal configured) is fine.
 * Never logs secret values, only their names.
 */
export async function seedVault(
  secrets: SecretsService,
  env: NodeJS.ProcessEnv,
  log: pino.Logger,
): Promise<{ seeded: string[]; skipped: string[] }> {
  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const name of SEED_SECRET_NAMES) {
    const value = env[name.toUpperCase()];
    if (value === undefined || value === '') {
      skipped.push(name);
      continue;
    }
    await secrets.set(name, value);
    seeded.push(name);
  }
  log.info({ seeded, skipped }, 'Vault seeding complete');
  return { seeded, skipped };
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('seed-vault: DATABASE_URL is not set');
    process.exit(1);
    throw new Error('unreachable'); // guards against process.exit mocks (mirrors the key branch below)
  }
  let key: Buffer;
  try {
    key = loadEncryptionKey();
  } catch (err) {
    logger.error({ err }, 'seed-vault: SECRET_ENCRYPTION_KEY is missing or invalid');
    process.exit(1);
    throw new Error('unreachable'); // guards against process.exit mocks
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const secrets = new SecretsService(pool, key, logger);
  seedVault(secrets, process.env, logger)
    .then(async () => {
      // setup.sh sets SEED_VAULT_VERIFY=1 so a partial/failed seed (e.g. the resume path
      // where api_token was never persisted) fails the install loudly instead of booting
      // with auth disabled. Ad-hoc single-secret runs (no flag) skip the required check.
      if (process.env.SEED_VAULT_VERIFY === '1') {
        const missing = await verifyRequiredSecrets(secrets, logger);
        if (missing.length > 0) {
          logger.error(
            { missing },
            'seed-vault: required secrets are not in the vault after seeding — install is incomplete',
          );
          await pool.end();
          process.exit(1);
        }
      }
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'seed-vault: fatal error');
      await pool.end();
      process.exit(1);
    });
}
