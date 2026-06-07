// secrets-service.ts — DB-backed, application-encrypted secrets store.
//
// Values are AES-256-GCM encrypted before write and decrypted on read; the DB
// never holds plaintext. `value_format` is structural (how to decode the value),
// never semantic — OAuth token sets and browser sessions are just 'json' secrets
// whose shape is a convention owned by their consumer. The service does NOT fire
// audit events; the execution-layer ctx.secret() closure remains the audit boundary.
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { encrypt, decrypt } from './crypto.js';

export type ValueFormat = 'string' | 'json';

export class SecretsService {
  constructor(
    private readonly pool: DbPool,
    private readonly key: Buffer,
    // Accepted for API consistency with other services; this service intentionally
    // does not log — errors propagate to the caller, which owns the audit boundary.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: Logger,
  ) {}

  /** Decrypt and return the raw string value, or null if no such secret. Works for any format. */
  async get(name: string): Promise<string | null> {
    const result = await this.pool.query<{ encrypted_value: string; iv: string }>(
      'SELECT encrypted_value, iv FROM secrets WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    if (!row) return null;
    // A decrypt failure (wrong key / corrupt row) is a real, loud problem — let it propagate.
    return decrypt(row.encrypted_value, row.iv, this.key);
  }

  /** Decrypt + JSON.parse a 'json' secret. Throws if the row is not 'json'. Null if missing. */
  async getJSON<T>(name: string): Promise<T | null> {
    const result = await this.pool.query<{ encrypted_value: string; iv: string; value_format: ValueFormat }>(
      'SELECT encrypted_value, iv, value_format FROM secrets WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.value_format !== 'json') {
      throw new Error(`Secret '${name}' has value_format '${row.value_format}', expected 'json'`);
    }
    // T is trusted by the caller — no runtime validation is performed here.
    // Callers storing structured secrets must validate the shape after retrieval
    // (e.g. with Zod or an explicit type guard) if they need a runtime guarantee.
    return JSON.parse(decrypt(row.encrypted_value, row.iv, this.key)) as T;
  }

  /** Encrypt and upsert a string secret. */
  async set(name: string, value: string): Promise<void> {
    const { ciphertext, iv } = encrypt(value, this.key);
    await this.upsert(name, 'string', ciphertext, iv);
  }

  /** JSON-serialize, encrypt, and upsert a structured secret. */
  async setJSON(name: string, obj: unknown): Promise<void> {
    const { ciphertext, iv } = encrypt(JSON.stringify(obj), this.key);
    await this.upsert(name, 'json', ciphertext, iv);
  }

  /** Remove a secret. No error if it does not exist. */
  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM secrets WHERE name = $1', [name]);
  }

  private async upsert(name: string, format: ValueFormat, ciphertext: string, iv: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO secrets (name, value_format, encrypted_value, iv, updated_at)
       VALUES ($1, $2, $3, $4, now())
      // created_at is set once on INSERT (DEFAULT now()) and never modified on conflict.
       ON CONFLICT (name) DO UPDATE
         SET value_format = EXCLUDED.value_format,
             encrypted_value = EXCLUDED.encrypted_value,
             iv = EXCLUDED.iv,
             updated_at = now()`,
      [name, format, ciphertext, iv],
    );
  }
}
