// Re-encrypt every row in the `secrets` table from an OLD key to a NEW key.
//
// Usage:
//   SECRET_ENCRYPTION_KEY_OLD=<base64> SECRET_ENCRYPTION_KEY_NEW=<base64> \
//     DATABASE_URL=<url> pnpm exec tsx scripts/rotate-secret-key.ts
//
// Runs in a single transaction: if anything fails, nothing changes — rerun safely.
// After it succeeds, set SECRET_ENCRYPTION_KEY to the NEW value and restart.
import pg from 'pg';
import pino from 'pino';
import { encrypt, decrypt } from '../src/secrets/crypto.js';

const logger = pino({ name: 'rotate-secret-key' });

function loadKey(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required (base64-encoded 32 bytes)`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes, got ${key.length}`);
  return key;
}

async function main(): Promise<void> {
  const oldKey = loadKey('SECRET_ENCRYPTION_KEY_OLD');
  const newKey = loadKey('SECRET_ENCRYPTION_KEY_NEW');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ name: string; encrypted_value: string; iv: string }>(
      'SELECT name, encrypted_value, iv FROM secrets FOR UPDATE',
    );
    for (const row of rows) {
      const plaintext = decrypt(row.encrypted_value, row.iv, oldKey);
      const reencrypted = encrypt(plaintext, newKey);
      // NOTE: no updated_at = now() here — the BEFORE UPDATE trigger on `secrets`
      // (added in migration 050) handles that automatically.
      await client.query(
        'UPDATE secrets SET encrypted_value = $1, iv = $2 WHERE name = $3',
        [reencrypted.ciphertext, reencrypted.iv, row.name],
      );
    }
    await client.query('COMMIT');
    logger.info({ count: rows.length }, 'Key rotation complete. Update SECRET_ENCRYPTION_KEY to the new value and restart.');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Log both errors: the rollback failure and the root cause that triggered it.
      // If we only throw rollbackErr, the original error (and which row failed) is lost.
      logger.error({ rollbackErr, originalErr: err }, 'ROLLBACK failed after rotation error');
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Key rotation failed');
  process.exit(1);
});
