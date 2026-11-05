// secrets-service.ts — DB-backed, application-encrypted secrets store.
//
// Values are AES-256-GCM encrypted before write and decrypted on read; the DB
// never holds plaintext. `value_format` is structural (how to decode the value),
// never semantic — OAuth token sets and browser sessions are just 'json' secrets
// whose shape is a convention owned by their consumer. The service does NOT fire
// audit events; the execution-layer ctx.secret() closure remains the audit boundary.
import type { DbPool, DbPoolClient } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { encrypt, decrypt } from './crypto.js';
import { hasUserSecretDetails, type UserSecretDetails } from './user-secret-details.js';
import {
  isStructuredSchemaTag,
  type CreditCardPublicFields,
  type CreditCardSecretDoc,
  type StructuredSchemaTag,
} from './structured-secret-schema.js';

/** Anything with a pg-style query method: the pool, or one client inside a transaction. */
type Queryable = Pick<DbPool, 'query'> | Pick<DbPoolClient, 'query'>;

export type ValueFormat = 'string' | 'json';

/** Non-secret facts about a stored secret. Deliberately has no value or ciphertext field. */
export interface SecretMetadata {
  name: string;
  valueFormat: ValueFormat;
  createdAt: Date;
  updatedAt: Date;
}

/** Partial edit of a key's sign-in details: an omitted field keeps its stored value, null clears it. */
export interface UserSecretDetailsPatch {
  loginUrl?: string | null;
  username?: string | null;
}

/** How a personal-secret write ended: written, or refused by the row's state at write time. */
export type PersonalSecretWrite =
  | { outcome: 'written'; replaced: boolean }
  /** The key holds a structured (JSON) value, which a string write never replaces. */
  | { outcome: 'structured' }
  /** The key is not in the vault (an edit never recreates a deleted key). */
  | { outcome: 'missing' };

export class SecretsService {
  constructor(
    private readonly pool: DbPool,
    private readonly key: Buffer,
    // Accepted for API consistency with other services; this service intentionally
    // does not log — errors propagate to the caller, which owns the audit boundary.
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
    await this.assertNotSavedCard(name);
    const { ciphertext, iv } = encrypt(value, this.key);
    await this.upsert(name, 'string', ciphertext, iv);
  }

  /** A generic write (a capture redeem) must not replace a saved card's encrypted document
   *  and leave its schema tag and public fields behind. Cards go through setCard /
   *  replaceCardSecret. */
  private async assertNotSavedCard(name: string): Promise<void> {
    if (!name.startsWith('user.')) return;
    if ((await this.getStructuredSchema(name)) !== null) {
      throw new Error(`'${name}' is a saved card; replace it from the Secrets page, not by a generic write`);
    }
  }

  /** JSON-serialize, encrypt, and upsert a structured secret. */
  async setJSON(name: string, obj: unknown): Promise<void> {
    await this.assertNotSavedCard(name);
    const { ciphertext, iv } = encrypt(JSON.stringify(obj), this.key);
    await this.upsert(name, 'json', ciphertext, iv);
  }

  /** List the names of all configured secrets — keys only, never values. Used by the
   *  registry UI to cross-reference a skill's install.requires_secrets, and by the
   *  install/enable gate to check that required keys are present. */
  async list(): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>('SELECT name FROM secrets ORDER BY name');
    return result.rows.map(r => r.name);
  }

  /** Name, format and timestamps of every secret. Never selects ciphertext or IV. */
  async listMetadata(): Promise<SecretMetadata[]> {
    const result = await this.pool.query<{ name: string; value_format: ValueFormat; created_at: Date; updated_at: Date }>(
      'SELECT name, value_format, created_at, updated_at FROM secrets ORDER BY name',
    );
    return result.rows.map(r => ({
      name: r.name,
      valueFormat: r.value_format,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Names of `user.*` secrets only — never values, never system/channel keys.
   *  Ordered oldest-first so capture dedup reuses the original key (#1497).
   *  Uses a prefix predicate (not list()+filter) so the full keyspace never
   *  enters this path. */
  async listUserNames(): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>(
      `SELECT name FROM secrets
        WHERE starts_with(name, 'user.')
        ORDER BY created_at ASC, name ASC`,
    );
    // Defense in depth: the SQL predicate is the real filter; this drop-guard
    // keeps a mismatched driver/mock from leaking a non-user name.
    return result.rows.map(r => r.name).filter(n => n.startsWith('user.'));
  }

  /** Non-secret sign-in details (login URL, username) per `user.*` key (#2201). Keys with
   *  no row are absent from the map. Never reads the secrets table. */
  async listUserDetails(): Promise<Map<string, UserSecretDetails>> {
    const result = await this.pool.query<{
      name: string; login_url: string | null; username: string | null;
      schema: string | null; label: string | null; public_fields: CreditCardPublicFields | null;
    }>(
      `SELECT name, login_url, username, schema, label, public_fields FROM user_secret_details
        WHERE starts_with(name, 'user.')`,
    );
    const out = new Map<string, UserSecretDetails>();
    for (const row of result.rows) {
      if (!row.name.startsWith('user.')) continue;
      out.set(row.name, {
        ...(row.login_url ? { loginUrl: row.login_url } : {}),
        ...(row.username ? { username: row.username } : {}),
        ...(isStructuredSchemaTag(row.schema) && row.public_fields
          ? { schema: row.schema, publicFields: row.public_fields }
          : {}),
        ...(row.label ? { label: row.label } : {}),
      });
    }
    return out;
  }

  /** Record sign-in details for a `user.*` key. Only the fields given are overwritten. */
  async upsertUserDetails(name: string, details: UserSecretDetails, db: Queryable = this.pool): Promise<void> {
    if (!name.startsWith('user.')) {
      throw new Error(`Sign-in details are only stored for user.* keys, not '${name}'`);
    }
    await db.query(
      `INSERT INTO user_secret_details (name, login_url, username)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET
         login_url  = COALESCE(EXCLUDED.login_url, user_secret_details.login_url),
         username   = COALESCE(EXCLUDED.username, user_secret_details.username),
         updated_at = now()`,
      [name, details.loginUrl ?? null, details.username ?? null],
    );
  }

  /** Edit sign-in details for a `user.*` key: an omitted field keeps its value, null clears it.
   *  Inserts the row if none exists. Unlike upsertUserDetails, null is a real "clear". */
  async patchUserDetails(name: string, patch: UserSecretDetailsPatch, db: Queryable = this.pool): Promise<void> {
    if (!name.startsWith('user.')) {
      throw new Error(`Sign-in details are only stored for user.* keys, not '${name}'`);
    }
    await db.query(
      `INSERT INTO user_secret_details (name, login_url, username)
       VALUES ($1, $3, $5)
       ON CONFLICT (name) DO UPDATE SET
         login_url  = CASE WHEN $2::boolean THEN $3::text ELSE user_secret_details.login_url END,
         username   = CASE WHEN $4::boolean THEN $5::text ELSE user_secret_details.username END,
         updated_at = now()`,
      [
        name,
        patch.loginUrl !== undefined, patch.loginUrl ?? null,
        patch.username !== undefined, patch.username ?? null,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Credit cards (#1358). Number and CVV are one encrypted json secret; the
  // non-secret facts live on the details row so viewing a card never decrypts.
  // -------------------------------------------------------------------------

  /** Save a card: encrypted doc in `secrets`, public fields in the details row, in one
   *  transaction. Existing login_url / username on the details row are kept. */
  async setCard(
    name: string,
    secret: CreditCardSecretDoc,
    publicFields: CreditCardPublicFields,
    label: string | null,
  ): Promise<void> {
    assertUserKey(name);
    await this.inTransaction(async client => {
      await this.writeJson(client, name, secret);
      await this.writeCardDetails(client, name, publicFields, label, true);
    });
  }

  /** The schema tag a key holds, from the details row only. Null for a plain or unknown key. */
  async getStructuredSchema(name: string): Promise<StructuredSchemaTag | null> {
    const result = await this.pool.query<{ schema: string | null }>(
      'SELECT schema FROM user_secret_details WHERE name = $1',
      [name],
    );
    const tag = result.rows[0]?.schema;
    return isStructuredSchemaTag(tag) ? tag : null;
  }

  /** A card's label and public fields. Reads the details row only: nothing is decrypted. */
  async getCardPublic(name: string): Promise<{ label: string | null; publicFields: CreditCardPublicFields } | null> {
    const result = await this.pool.query<{ label: string | null; public_fields: CreditCardPublicFields | null; schema: string | null }>(
      'SELECT label, public_fields, schema FROM user_secret_details WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    if (!row || row.schema !== 'credit_card' || !row.public_fields) return null;
    return { label: row.label, publicFields: row.public_fields };
  }

  /** Edit a card's label and/or public fields. Never writes `secrets`, so the vault row's
   *  updated_at is untouched. Omitted keys are kept; `label: null` clears the label. */
  async patchCardPublic(
    name: string,
    patch: { label?: string | null; publicFields?: CreditCardPublicFields },
  ): Promise<void> {
    assertUserKey(name);
    const result = await this.pool.query(
      `UPDATE user_secret_details SET
         label         = CASE WHEN $2::boolean THEN $3::text ELSE label END,
         public_fields = CASE WHEN $4::boolean THEN $5::jsonb ELSE public_fields END,
         updated_at    = now()
       WHERE name = $1 AND schema = 'credit_card'`,
      [
        name,
        patch.label !== undefined, patch.label ?? null,
        patch.publicFields !== undefined,
        patch.publicFields === undefined ? null : JSON.stringify(patch.publicFields),
      ],
    );
    if (result.rowCount === 0) throw new Error(`'${name}' is not a saved card`);
  }

  /** Replace a card's secret. `{ cvv }` swaps only the CVV and keeps the number; the full
   *  form replaces the doc and the public fields. One transaction. */
  async replaceCardSecret(
    name: string,
    change: { cvv: string } | { secret: CreditCardSecretDoc; publicFields: CreditCardPublicFields },
  ): Promise<void> {
    assertUserKey(name);
    if ('cvv' in change) {
      // Read-modify-write under a row lock, so a racing replace cannot be overwritten
      // with the number this call read before it.
      await this.inTransaction(async client => {
        const row = (await client.query<{ encrypted_value: string; iv: string; value_format: ValueFormat }>(
          'SELECT encrypted_value, iv, value_format FROM secrets WHERE name = $1 FOR UPDATE',
          [name],
        )).rows[0];
        if (!row || row.value_format !== 'json') throw new Error(`Secret '${name}' is not a credit_card`);
        const doc = JSON.parse(decrypt(row.encrypted_value, row.iv, this.key)) as { _schema?: unknown };
        if (doc._schema !== 'credit_card') throw new Error(`Secret '${name}' is not a credit_card`);
        await this.writeJson(client, name, { ...(doc as unknown as CreditCardSecretDoc), cvv: change.cvv });
      });
      return;
    }
    await this.inTransaction(async client => {
      await this.writeJson(client, name, change.secret);
      // Keep the existing label; only the public fields change here.
      await this.writeCardDetails(client, name, change.publicFields, null, false);
    });
  }

  /** The decrypted card doc. For the resolver only. Throws unless the stored doc is a credit_card. */
  async getCardSecret(name: string): Promise<CreditCardSecretDoc> {
    const doc = await this.getJSON<{ _schema?: unknown }>(name);
    if (doc === null || doc._schema !== 'credit_card') {
      throw new Error(`Secret '${name}' is not a credit_card`);
    }
    // _schema was checked above; the rest of the shape was validated when the card was saved.
    return doc as unknown as CreditCardSecretDoc;
  }

  /** Remove a key's sign-in details. No error if there are none. */
  async deleteUserDetails(name: string): Promise<void> {
    await this.pool.query('DELETE FROM user_secret_details WHERE name = $1', [name]);
  }

  /** Remove a secret. No error if it does not exist. A `user.*` key's sign-in details go with
   *  it, in the same transaction, so neither can outlive the other: stale details would show
   *  under a later secret of the same name, and a failed delete keeps both. */
  async delete(name: string): Promise<void> {
    if (!name.startsWith('user.')) {
      await this.pool.query('DELETE FROM secrets WHERE name = $1', [name]);
      return;
    }
    await this.transaction(async (db) => {
      await db.query('DELETE FROM user_secret_details WHERE name = $1', [name]);
      await db.query('DELETE FROM secrets WHERE name = $1', [name]);
    });
  }

  /**
   * Create or replace a personal string secret and record its sign-in details, in one
   * transaction. The value write is conditional: a key that holds a JSON value (a capture's
   * structure) is never replaced, even if it became JSON after the caller's check.
   * Details are written only when some are given, merged as upsertUserDetails does.
   */
  async setUserSecret(name: string, value: string, details: UserSecretDetails): Promise<PersonalSecretWrite> {
    if (!name.startsWith('user.')) throw new Error(`Not a personal secret: '${name}'`);
    const { ciphertext, iv } = encrypt(value, this.key);
    return this.transaction(async (db) => {
      const existed = (await db.query('SELECT 1 FROM secrets WHERE name = $1 FOR UPDATE', [name])).rowCount ?? 0;
      const written = await db.query(
        `INSERT INTO secrets (name, value_format, encrypted_value, iv, updated_at)
         VALUES ($1, 'string', $2, $3, now())
         ON CONFLICT (name) DO UPDATE
           SET encrypted_value = EXCLUDED.encrypted_value, iv = EXCLUDED.iv, updated_at = now()
           WHERE secrets.value_format = 'string'`,
        [name, ciphertext, iv],
      );
      if ((written.rowCount ?? 0) === 0) return { outcome: 'structured' as const };
      if (hasUserSecretDetails(details)) await this.upsertUserDetails(name, details, db);
      return { outcome: 'written' as const, replaced: existed > 0 };
    });
  }

  /**
   * Edit an existing personal secret: its string value, its sign-in details, or both, in one
   * transaction. The row is locked first, so a delete or a capture can't land between the
   * check and the write: a missing key is not recreated, and a JSON value is not replaced.
   */
  async editUserSecret(name: string, edit: { value?: string; details?: UserSecretDetailsPatch }): Promise<PersonalSecretWrite> {
    if (!name.startsWith('user.')) throw new Error(`Not a personal secret: '${name}'`);
    const sealed = edit.value !== undefined ? encrypt(edit.value, this.key) : undefined;
    return this.transaction(async (db) => {
      const row = (await db.query<{ value_format: ValueFormat }>(
        'SELECT value_format FROM secrets WHERE name = $1 FOR UPDATE', [name],
      )).rows[0];
      if (!row) return { outcome: 'missing' as const };
      if (sealed && row.value_format !== 'string') return { outcome: 'structured' as const };
      if (sealed) {
        await db.query(
          'UPDATE secrets SET encrypted_value = $2, iv = $3, updated_at = now() WHERE name = $1',
          [name, sealed.ciphertext, sealed.iv],
        );
      }
      if (edit.details && (edit.details.loginUrl !== undefined || edit.details.username !== undefined)) {
        await this.patchUserDetails(name, edit.details, db);
      }
      return { outcome: 'written' as const, replaced: true };
    });
  }

  /** Run `fn` in one transaction on a dedicated client; rolled back if it throws. */
  private async transaction<T>(fn: (db: DbPoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is likely gone: the original error is the one to report, and the
        // client is destroyed below rather than returned to the pool mid-transaction.
        broken = true;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  private async upsert(name: string, format: ValueFormat, ciphertext: string, iv: string): Promise<void> {
    await upsertSecretRow(this.pool, name, format, ciphertext, iv);
  }

  private async writeJson(db: Queryable, name: string, obj: unknown): Promise<void> {
    const { ciphertext, iv } = encrypt(JSON.stringify(obj), this.key);
    await upsertSecretRow(db, name, 'json', ciphertext, iv);
  }

  /** Upsert the card columns of the details row, leaving login_url / username alone.
   *  `setLabel` false keeps an existing label (used when only the secret is replaced). */
  private async writeCardDetails(
    db: Queryable,
    name: string,
    publicFields: CreditCardPublicFields,
    label: string | null,
    setLabel: boolean,
  ): Promise<void> {
    await db.query(
      `INSERT INTO user_secret_details (name, schema, label, public_fields)
       VALUES ($1, 'credit_card', $2, $3::jsonb)
       ON CONFLICT (name) DO UPDATE SET
         schema        = 'credit_card',
         label         = CASE WHEN $4::boolean THEN EXCLUDED.label ELSE user_secret_details.label END,
         public_fields = EXCLUDED.public_fields,
         updated_at    = now()`,
      [name, label, JSON.stringify(publicFields), setLabel],
    );
  }

  private async inTransaction<T>(fn: (client: DbPoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      // Roll back, then rethrow the original failure; a failed rollback must not mask it.
      // A failed rollback means the connection is likely dead: destroy it rather than pool it.
      await client.query('ROLLBACK').catch(() => { broken = true; });
      throw err;
    } finally {
      client.release(broken);
    }
  }
}

function assertUserKey(name: string): void {
  if (!name.startsWith('user.')) {
    throw new Error(`Cards are only stored under user.* keys, not '${name}'`);
  }
}

async function upsertSecretRow(
  db: Queryable, name: string, format: ValueFormat, ciphertext: string, iv: string,
): Promise<void> {
  await db.query(
    `INSERT INTO secrets (name, value_format, encrypted_value, iv, updated_at)
     VALUES ($1, $2, $3, $4, now())
    -- created_at is set once on INSERT (DEFAULT now()) and never modified on conflict.
     ON CONFLICT (name) DO UPDATE
       SET value_format = EXCLUDED.value_format,
           encrypted_value = EXCLUDED.encrypted_value,
           iv = EXCLUDED.iv,
           updated_at = now()`,
    [name, format, ciphertext, iv],
  );
}
