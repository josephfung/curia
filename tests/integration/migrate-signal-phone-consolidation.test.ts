// Integration test — runs the 068 migration SQL against a live Postgres and asserts the
// flat→namespaced Signal phone consolidation. Skips without DATABASE_URL + SECRET_ENCRYPTION_KEY.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { readFile } from 'node:fs/promises';
import { loadEncryptionKey } from '../../src/secrets/crypto.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL && process.env.SECRET_ENCRYPTION_KEY ? describe : describe.skip;
const logger = pino({ level: 'silent' });

const MIGRATION_SQL_URL = new URL(
  '../../src/db/migrations/068_consolidate_signal_phone_number.sql',
  import.meta.url,
);
const FLAT = 'signal_phone_number';
const NAMESPACED = 'channel.signal.phone_number';

describeIf('migration 068: consolidate signal phone number', () => {
  let pool: pg.Pool;
  let secrets: SecretsService;
  let migrationSql: string;
  // Snapshot of any pre-existing rows for the two keys we mutate. These tests overwrite and
  // DELETE real secret names, so if DATABASE_URL is ever pointed at a non-throwaway DB (e.g.
  // prod), an unconditional cleanup would destroy live Signal secrets. We capture them once
  // before any test mutates state and restore them after the suite.
  let preExisting: Array<{ name: string; value_format: string; encrypted_value: string; iv: string }> = [];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    secrets = new SecretsService(pool, loadEncryptionKey(), logger);
    migrationSql = await readFile(MIGRATION_SQL_URL, 'utf8');
    const { rows } = await pool.query<{ name: string; value_format: string; encrypted_value: string; iv: string }>(
      'SELECT name, value_format, encrypted_value, iv FROM secrets WHERE name = ANY($1)',
      [[FLAT, NAMESPACED]],
    );
    preExisting = rows;
  });

  // Clean slate before each case (also clears any pre-existing rows captured above, so a real
  // value in the vault can't interfere with the backfill/no-clobber assertions). afterAll restores.
  beforeEach(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[FLAT, NAMESPACED]]);
  });

  afterAll(async () => {
    // Leave the vault exactly as found: clear the test rows, then re-insert anything captured in
    // beforeAll. So even a mispointed DATABASE_URL (e.g. prod) keeps its original ciphertext+iv.
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[FLAT, NAMESPACED]]);
    for (const row of preExisting) {
      await pool.query(
        `INSERT INTO secrets (name, value_format, encrypted_value, iv)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE
           SET value_format = EXCLUDED.value_format,
               encrypted_value = EXCLUDED.encrypted_value,
               iv = EXCLUDED.iv`,
        [row.name, row.value_format, row.encrypted_value, row.iv],
      );
    }
    await pool.end();
  });

  it('backfills the namespaced key from the legacy flat key, then drops the flat row', async () => {
    await secrets.set(FLAT, '+12223334444');
    await pool.query(migrationSql);
    expect(await secrets.get(NAMESPACED)).toBe('+12223334444');
    expect(await secrets.get(FLAT)).toBeNull();
  });

  it('never clobbers an existing console-written namespaced value', async () => {
    await secrets.set(FLAT, '+19999999999');      // stale legacy value
    await secrets.set(NAMESPACED, '+12223334444'); // console entry must win
    await pool.query(migrationSql);
    expect(await secrets.get(NAMESPACED)).toBe('+12223334444');
    expect(await secrets.get(FLAT)).toBeNull();    // flat row still removed
  });

  it('is a no-op when neither key exists (env-only / unconfigured deployment)', async () => {
    await pool.query(migrationSql);
    expect(await secrets.get(NAMESPACED)).toBeNull();
    expect(await secrets.get(FLAT)).toBeNull();
  });

  it('is idempotent — a second run changes nothing', async () => {
    await secrets.set(FLAT, '+12223334444');
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    expect(await secrets.get(NAMESPACED)).toBe('+12223334444');
    expect(await secrets.get(FLAT)).toBeNull();
  });
});
