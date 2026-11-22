// store.ts — typed reads and writes for the settings registry (#2709).
//
// Reads validate against the key's schema and never trust a stored value: one that fails
// its schema (hand-written through psql, say) is logged at error level and read as unset.
// Writes validate first, then change the row and append a settings_history row in the same
// transaction, so "who changed X, and when" and the value itself can never disagree.

import type { Logger } from '../logger.js';
import {
  isSettingKey,
  SETTINGS,
  type SettingDefinition,
  type SettingKey,
  type SettingValues,
} from './registry.js';

/** The read surface: a pool, a pooled client, or a test double. */
export interface SettingsQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A pooled client. Writes release it when the transaction ends. */
export interface SettingsClient extends SettingsQueryable {
  release(): void;
}

/** The write surface: a real pool, because a write needs its own transaction. */
export interface SettingsPool extends SettingsQueryable {
  connect(): Promise<SettingsClient>;
}

export type SettingsValues<K extends SettingKey> = Partial<Pick<SettingValues, K>>;

/** A stored value and who wrote it, for a read that needs the provenance (Setup's page rule). */
export interface SettingRecord<T> {
  value: T;
  updatedBy: string;
}

export type SettingRecords<K extends SettingKey> = {
  [P in K]: SettingRecord<SettingValues[P]>;
};

/** One write: a value to store, or `null` to clear the key. */
export type SettingsChange = {
  [K in SettingKey]: { key: K; value: SettingValues[K] | null };
}[SettingKey];

/** A key that is not in the registry. Typed callers cannot reach this; runtime input can. */
export class UnknownSettingError extends Error {
  constructor(key: string) {
    super(`Unknown setting '${key}'.`);
    this.name = 'UnknownSettingError';
  }
}

/** A value that fails its key's schema. Nothing is written. */
export class InvalidSettingError extends Error {
  readonly key: SettingKey;

  constructor(key: SettingKey, reason: string) {
    super(`Invalid value for setting '${key}': ${reason}.`);
    this.name = 'InvalidSettingError';
    this.key = key;
  }
}

function assertKnownKey(key: string): asserts key is SettingKey {
  if (!isSettingKey(key)) throw new UnknownSettingError(key);
}

/** Structural equality for the JSON values the registry stores. Key order does not matter. */
function settingsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && settingsEqual(left[key], right[key]));
}

function validateChange(change: SettingsChange): { key: SettingKey; value: unknown | null } {
  assertKnownKey(change.key);
  const definition = SETTINGS[change.key] as SettingDefinition<unknown>;
  if (change.value === null) return { key: change.key, value: null };
  const parsed = definition.parse(change.value);
  if (!parsed.ok) throw new InvalidSettingError(change.key, parsed.error);
  return { key: change.key, value: parsed.value };
}

/**
 * Read and validate several keys in one query, with each value's writer. A key with no row
 * is absent. An invalid stored value is logged and reported as absent.
 */
export async function getSettingRecords<K extends SettingKey>(
  db: SettingsQueryable,
  keys: readonly K[],
  logger: Pick<Logger, 'error'>,
): Promise<Partial<SettingRecords<K>>> {
  for (const key of keys) assertKnownKey(key);
  if (keys.length === 0) return {};

  const { rows } = await db.query(
    'SELECT key, value, updated_by FROM settings WHERE key = ANY($1::text[])',
    [keys as readonly string[]],
  );
  const stored = new Map<string, { value: unknown; updatedBy: string }>(
    rows.map((row) => [
      String(row['key']),
      { value: row['value'], updatedBy: String(row['updated_by'] ?? '') },
    ]),
  );

  const records: Partial<Record<SettingKey, SettingRecord<unknown>>> = {};
  for (const key of keys) {
    const row = stored.get(key);
    if (!row) continue;
    const definition = SETTINGS[key] as SettingDefinition<SettingValues[K]>;
    const parsed = definition.parse(row.value);
    if (!parsed.ok) {
      // Never trust a stored value that fails its schema: log it and act as if it were absent.
      logger.error(
        { settingKey: key, reason: parsed.error },
        'settings: stored value failed its schema — treating it as unset',
      );
      continue;
    }
    records[key] = { value: parsed.value, updatedBy: row.updatedBy };
  }
  return records as Partial<SettingRecords<K>>;
}

/**
 * Read and validate several keys in one query. A key with no row is absent unless the
 * registry declares a default. An invalid stored value is logged and read as unset.
 */
export async function getSettings<K extends SettingKey>(
  db: SettingsQueryable,
  keys: readonly K[],
  logger: Pick<Logger, 'error'>,
): Promise<SettingsValues<K>> {
  const records = await getSettingRecords(db, keys, logger);
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const record = records[key];
    if (record) {
      values[key] = record.value;
      continue;
    }
    const definition = SETTINGS[key] as SettingDefinition<SettingValues[K]>;
    if (definition.default !== undefined) values[key] = definition.default;
  }
  return values as SettingsValues<K>;
}

/** One key. Absent (or invalid, logged) reads as `undefined` unless it has a default. */
export async function getSetting<K extends SettingKey>(
  db: SettingsQueryable,
  key: K,
  logger: Pick<Logger, 'error'>,
): Promise<SettingValues[K] | undefined> {
  const values = await getSettings(db, [key], logger);
  return values[key];
}

/**
 * Write one value and its history row in one transaction. Throws `InvalidSettingError`
 * before touching the database when the value fails its schema.
 */
export async function setSetting<K extends SettingKey>(
  pool: SettingsPool,
  key: K,
  value: SettingValues[K],
  updatedBy: string,
  logger: Pick<Logger, 'error'>,
): Promise<void> {
  await writeSettings(pool, [{ key, value } as SettingsChange], updatedBy, logger);
}

/**
 * Write one value only when the key has no usable value yet. Returns whether it wrote.
 * An existing row whose value fails its schema counts as absent, so a hand-written bad
 * value cannot permanently block a write that must happen once (Setup completion).
 */
export async function setSettingIfAbsent<K extends SettingKey>(
  pool: SettingsPool,
  key: K,
  value: SettingValues[K],
  updatedBy: string,
  logger: Pick<Logger, 'error'>,
): Promise<boolean> {
  if (updatedBy.trim() === '') throw new Error('settings: updatedBy is required');
  const change = validateChange({ key, value } as SettingsChange);
  const definition = SETTINGS[change.key] as SettingDefinition<unknown>;

  return runInTransaction(pool, logger, async (client) => {
    await lockKeys(client, [change.key]);
    const existing = await client.query('SELECT value FROM settings WHERE key = $1 FOR UPDATE', [change.key]);
    const raw = existing.rows[0]?.['value'];
    if (existing.rows.length > 0 && definition.parse(raw).ok) return false;

    await client.query(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [change.key, JSON.stringify(change.value), updatedBy],
    );
    await appendHistory(client, change.key, raw ?? null, change.value, updatedBy);
    return true;
  });
}

/** Clear one key, appending a history row with a null new value. No-op when already absent. */
export async function clearSetting(
  pool: SettingsPool,
  key: SettingKey,
  updatedBy: string,
  logger: Pick<Logger, 'error'>,
): Promise<void> {
  await writeSettings(pool, [{ key, value: null } as SettingsChange], updatedBy, logger);
}

async function appendHistory(
  client: SettingsQueryable,
  key: SettingKey,
  oldValue: unknown,
  newValue: unknown,
  updatedBy: string,
): Promise<void> {
  await client.query(
    `INSERT INTO settings_history (key, old_value, new_value, updated_by)
     VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
    [
      key,
      oldValue === null || oldValue === undefined ? null : JSON.stringify(oldValue),
      newValue === null || newValue === undefined ? null : JSON.stringify(newValue),
      updatedBy,
    ],
  );
}

async function runInTransaction<T>(
  pool: SettingsPool,
  logger: Pick<Logger, 'error'>,
  fn: (client: SettingsClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Never mask the failure that caused the rollback.
      logger.error({ rollbackErr }, 'settings: rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A row that does not exist yet is not locked by `SELECT … FOR UPDATE`, so two concurrent
 * first writes would both record `old_value = null`. A transaction-scoped advisory lock per
 * key serializes them; taking the keys in sorted order means two multi-key writes cannot
 * deadlock against each other.
 */
async function lockKeys(client: SettingsClient, keys: readonly SettingKey[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [key]);
  }
}

/**
 * Write several keys in one transaction, each with its history row. Any failure (a schema
 * violation, a failed history insert, a lost connection) rolls the whole set back, so the
 * store never holds a value whose change was not recorded. A value equal to the stored one
 * is not rewritten and gets no history row.
 */
export async function writeSettings(
  pool: SettingsPool,
  changes: readonly SettingsChange[],
  updatedBy: string,
  logger: Pick<Logger, 'error'>,
): Promise<void> {
  if (changes.length === 0) return;
  if (updatedBy.trim() === '') throw new Error('settings: updatedBy is required');

  // Validate everything before opening the transaction: a refused value writes nothing.
  const validated = changes.map(validateChange);

  await runInTransaction(pool, logger, async (client) => {
    await lockKeys(client, validated.map((change) => change.key));
    for (const change of validated) {
      if (change.value === null) {
        const deleted = await client.query(
          'DELETE FROM settings WHERE key = $1 RETURNING value',
          [change.key],
        );
        // Clearing a key that was never set is not a change worth a history row.
        const old = deleted.rows[0];
        if (!old) continue;
        await appendHistory(client, change.key, old['value'], null, updatedBy);
        continue;
      }
      const prior = await client.query(
        'SELECT value FROM settings WHERE key = $1 FOR UPDATE',
        [change.key],
      );
      const old = prior.rows[0]?.['value'];
      // Re-saving an unchanged value is not a change: no write, no history row.
      if (prior.rows.length > 0 && settingsEqual(old, change.value)) continue;
      await client.query(
        `INSERT INTO settings (key, value, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [change.key, JSON.stringify(change.value), updatedBy],
      );
      await appendHistory(client, change.key, old ?? null, change.value, updatedBy);
    }
  });
}
