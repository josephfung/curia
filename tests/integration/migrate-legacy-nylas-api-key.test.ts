// Integration test — runs the 122 migration SQL against a live Postgres and asserts the
// legacy nylas_api_key → channel.email.nylas_api_key rename (#2522). Skips without
// DATABASE_URL + SECRET_ENCRYPTION_KEY.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { readFile } from 'node:fs/promises';
import { loadEncryptionKey } from '../../src/secrets/crypto.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL && process.env.SECRET_ENCRYPTION_KEY ? describe : describe.skip;
const logger = pino({ level: 'silent' });

const MIGRATION_SQL_URL = new URL(
  '../../src/db/migrations/122_rename_legacy_nylas_api_key.sql',
  import.meta.url,
);
// The suite runs the migration's own SQL with these two names substituted for the real ones.
// Integration files run in parallel on one database, and seed-vault.test.ts writes and deletes
// channel.email.nylas_api_key, so the real names would race it.
const LEGACY = 'test_2522.nylas_api_key';
const CANONICAL = 'test_2522.channel.email.nylas_api_key';

describeIf('migration 122: rename legacy nylas_api_key', () => {
  let pool: pg.Pool;
  let secrets: SecretsService;
  let migrationSql: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    secrets = new SecretsService(pool, loadEncryptionKey(), logger);
    const raw = await readFile(MIGRATION_SQL_URL, 'utf8');
    migrationSql = raw
      .replaceAll("'channel.email.nylas_api_key'", `'${CANONICAL}'`)
      .replaceAll("'nylas_api_key'", `'${LEGACY}'`);
    // Every literal was swapped: the SQL names neither real key any more.
    expect(migrationSql).not.toMatch(/'(channel\.email\.)?nylas_api_key'/);
    expect(migrationSql).toContain(`'${CANONICAL}'`);
    expect(migrationSql).toContain(`'${LEGACY}'`);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[LEGACY, CANONICAL]]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[LEGACY, CANONICAL]]);
    await pool.end();
  });

  it('renames the legacy row, and the renamed secret decrypts to the original value', async () => {
    await secrets.set(LEGACY, 'nyk_v0_original');
    const before = await pool.query<{ encrypted_value: string; iv: string }>(
      'SELECT encrypted_value, iv FROM secrets WHERE name = $1',
      [LEGACY],
    );
    await pool.query(migrationSql);
    expect(await secrets.get(CANONICAL)).toBe('nyk_v0_original');
    expect(await secrets.get(LEGACY)).toBeNull();
    // A rename, not a re-encrypt: ciphertext and IV carry over byte for byte.
    const after = await pool.query<{ encrypted_value: string; iv: string }>(
      'SELECT encrypted_value, iv FROM secrets WHERE name = $1',
      [CANONICAL],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('leaves both rows untouched when the canonical key already exists', async () => {
    await secrets.set(LEGACY, 'nyk_v0_stale');
    await secrets.set(CANONICAL, 'nyk_v0_console');
    await pool.query(migrationSql);
    expect(await secrets.get(CANONICAL)).toBe('nyk_v0_console');
    expect(await secrets.get(LEGACY)).toBe('nyk_v0_stale');
  });

  it('is a no-op when neither key exists', async () => {
    await pool.query(migrationSql);
    expect(await secrets.get(CANONICAL)).toBeNull();
    expect(await secrets.get(LEGACY)).toBeNull();
  });

  it('is idempotent — a second run changes nothing', async () => {
    await secrets.set(LEGACY, 'nyk_v0_original');
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    expect(await secrets.get(CANONICAL)).toBe('nyk_v0_original');
    expect(await secrets.get(LEGACY)).toBeNull();
  });
});
