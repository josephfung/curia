// The settings store against a real Postgres (#2709): the history row every write appends in
// the same transaction, the rollback when that history write fails, append-only history, and a
// stored value that fails its schema reading as unset.
//
// Runs on its own freshly migrated scratch database because the four settings keys are shared
// with the Setup suites: a parallel file writing messaging_route would race the history rows
// this file asserts on.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { createScratchDatabase, type ScratchDatabase } from './scratch-database.js';
import { createSilentLogger } from '../../src/logger.js';
import { getSetting, setSetting, clearSetting } from '../../src/settings/store.js';
import { EMPTY_SETUP_STATE, readSetupState } from '../../src/setup/setup-settings.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const KEY = 'messaging_route' as const;

describeIf('settings store (Postgres)', () => {
  let scratch: ScratchDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    scratch = await createScratchDatabase(DATABASE_URL!, 'settings_store');
    pool = new pg.Pool({ connectionString: scratch.url });
  });

  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  beforeEach(async () => {
    // settings_history is append-only, so only the current value is cleared between tests.
    await pool.query('DELETE FROM settings WHERE key = $1', [KEY]);
  });

  it('stores the value and appends the first history row', async () => {
    await setSetting(pool, KEY, 'signal', 'console');
    expect(await getSetting(pool, KEY)).toBe('signal');

    const { rows } = await pool.query(
      `SELECT old_value, new_value, updated_by FROM settings_history
        WHERE key = $1 ORDER BY id DESC LIMIT 1`,
      [KEY],
    );
    expect(rows[0]).toMatchObject({ old_value: null, new_value: 'signal', updated_by: 'console' });
  });

  it('records the prior value when a key changes', async () => {
    await setSetting(pool, KEY, 'signal', 'console');
    await setSetting(pool, KEY, 'slack', 'admin');

    const { rows } = await pool.query(
      `SELECT old_value, new_value, updated_by FROM settings_history
        WHERE key = $1 ORDER BY id DESC LIMIT 1`,
      [KEY],
    );
    expect(rows[0]).toMatchObject({ old_value: 'signal', new_value: 'slack', updated_by: 'admin' });
  });

  it('records a clear as a history row with a null new value', async () => {
    await setSetting(pool, KEY, 'signal', 'console');
    await clearSetting(pool, KEY, 'console');

    expect(await getSetting(pool, KEY)).toBeUndefined();
    const { rows } = await pool.query(
      `SELECT old_value, new_value FROM settings_history
        WHERE key = $1 ORDER BY id DESC LIMIT 1`,
      [KEY],
    );
    expect(rows[0]).toMatchObject({ old_value: 'signal', new_value: null });
  });

  it('rolls the setting back when the history write fails', async () => {
    await setSetting(pool, KEY, 'signal', 'console');
    // A trigger on the history insert is the one way to make that write fail on its own.
    await pool.query(`
      CREATE OR REPLACE FUNCTION settings_test_fail_history() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'settings history write failed';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER settings_test_fail_history
        BEFORE INSERT ON settings_history
        FOR EACH ROW EXECUTE FUNCTION settings_test_fail_history();
    `);
    try {
      await expect(setSetting(pool, KEY, 'slack', 'console')).rejects.toThrow('settings history write failed');
      // The value the store held before the failed write is untouched.
      expect(await getSetting(pool, KEY)).toBe('signal');
    } finally {
      await pool.query('DROP TRIGGER settings_test_fail_history ON settings_history');
      await pool.query('DROP FUNCTION settings_test_fail_history()');
    }
  });

  it('keeps settings_history append-only', async () => {
    await setSetting(pool, KEY, 'signal', 'console');
    await expect(
      pool.query(`UPDATE settings_history SET updated_by = 'rewritten' WHERE key = $1`, [KEY]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM settings_history WHERE key = $1', [KEY]),
    ).rejects.toThrow(/append-only/);
  });

  it('reads a stored value that fails its schema as unset, at error level', async () => {
    await setSetting(pool, KEY, 'signal', 'console');
    // As if someone wrote it by hand through psql: valid JSONB, not a valid route.
    await pool.query(`UPDATE settings SET value = to_jsonb($1::text) WHERE key = $2`, ['carrier-pigeon', KEY]);

    const logger = createSilentLogger();
    const error = vi.spyOn(logger, 'error');
    expect(await getSetting(pool, KEY, logger)).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ settingKey: KEY }),
      expect.stringContaining('treating it as unset'),
    );
  });

  it('derives the Setup phase and setup_for from the four keys', async () => {
    expect(await readSetupState(pool)).toEqual(EMPTY_SETUP_STATE);

    await setSetting(pool, 'operator', { name: 'Sam', email: 'sam@example.com' }, 'console');
    await setSetting(pool, 'setup.completed_at', new Date('2026-01-01T00:00:00Z').toISOString(), 'console');
    expect(await readSetupState(pool)).toMatchObject({
      phase: 'complete',
      setupFor: 'other',
      operatorName: 'Sam',
      operatorEmail: 'sam@example.com',
    });

    await clearSetting(pool, 'operator', 'console');
    expect(await readSetupState(pool)).toMatchObject({ setupFor: 'self', operatorName: null });
  });
});
