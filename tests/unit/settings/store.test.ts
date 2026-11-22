// The typed settings registry and store (#2709): each key's schema, the read that refuses
// to trust a bad stored value, the transaction every write uses, and the first-wins write.
import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '../../../src/logger.js';
import {
  SETTINGS,
  isSettingKey,
  settingKeys,
} from '../../../src/settings/registry.js';
import {
  InvalidSettingError,
  UnknownSettingError,
  getSetting,
  getSettingRecords,
  setSetting,
  setSettingIfAbsent,
  writeSettings,
} from '../../../src/settings/store.js';

const EXPECTED_KEYS = ['messaging_route', 'operator', 'operator_confirmation', 'setup.completed_at', 'voice_route'];

function fakeLogger(): { logger: Pick<Logger, 'error'>; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  return { logger: { error } as unknown as Pick<Logger, 'error'>, error };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

interface StoredRow extends Record<string, unknown> {
  key: string;
  value: unknown;
  updated_by: string;
}

function fakePool(options: { failOn?: string; existing?: StoredRow[] } = {}) {
  const statements: string[] = [];
  const lockedKeys: string[] = [];
  const existing = options.existing ?? [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (options.failOn && sql.includes(options.failOn)) throw new Error('history write failed');
      if (sql.includes('pg_advisory_xact_lock')) lockedKeys.push(String(params?.[0]));
      if (sql.includes('SELECT value FROM settings')) {
        const key = String(params?.[0]);
        return { rows: existing.filter((row) => row.key === key).map((row) => ({ value: row.value })) };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    statements,
    lockedKeys,
    client,
    pool: {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM settings')) return { rows: existing };
        return { rows: [] };
      }),
      connect: vi.fn(async () => client),
    },
  };
}

describe('settings registry', () => {
  it('declares exactly the Setup and operator keys, each with a purpose, a default and a parser', () => {
    expect(settingKeys().sort()).toEqual(EXPECTED_KEYS);
    for (const key of settingKeys()) {
      expect(SETTINGS[key].purpose.length).toBeGreaterThan(0);
      expect(SETTINGS[key].parse).toBeTypeOf('function');
      // Absent is the default: a missing row means "not answered yet".
      expect(SETTINGS[key].default).toBeUndefined();
    }
  });

  it('accepts a complete operator and rejects every other shape', () => {
    expect(SETTINGS.operator.parse({ name: ' Sam ', email: 'Sam@Example.com' })).toEqual(
      ok({ name: 'Sam', email: 'sam@example.com' }),
    );
    for (const bad of [
      null,
      'Sam',
      ['Sam'],
      {},
      { name: 'Sam' },
      { name: 'Sam', email: 'not-an-email' },
      { name: '', email: 'sam@example.com' },
      { name: 'Sam', email: 'sam@example.com', extra: true },
    ]) {
      expect(SETTINGS.operator.parse(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps the operator name to one line, so it cannot forge a line of the notice body (#2710)', () => {
    // The name is rendered into the confirmation notice, so a newline must not survive.
    expect(SETTINGS.operator.parse({ name: 'Sam\nBcc: someone@example.com', email: 'sam@example.com' }))
      .toEqual(ok({ name: 'Sam Bcc: someone@example.com', email: 'sam@example.com' }));
    expect(SETTINGS.operator.parse({ name: ' Sam   Rivera\t ', email: 'sam@example.com' }))
      .toEqual(ok({ name: 'Sam Rivera', email: 'sam@example.com' }));
    // A name that is only whitespace is still not a name.
    expect(SETTINGS.operator.parse({ name: '\n\t ', email: 'sam@example.com' }).ok).toBe(false);
  });

  it('accepts a confirmation record and rejects a malformed one', () => {
    const at = '2026-11-22T12:00:00.000Z';
    expect(SETTINGS.operator_confirmation.parse({ email: 'Sam@Example.com', attemptedAt: at, sentAt: at }))
      .toEqual(ok({ email: 'sam@example.com', attemptedAt: at, sentAt: at }));
    // A failed attempt records a null sentAt: the notice is owed, not delivered.
    expect(SETTINGS.operator_confirmation.parse({ email: 'sam@example.com', attemptedAt: at, sentAt: null }))
      .toEqual(ok({ email: 'sam@example.com', attemptedAt: at, sentAt: null }));
    for (const bad of [
      null,
      'sam@example.com',
      {},
      { email: 'nope', attemptedAt: at, sentAt: at },
      { email: 'sam@example.com', attemptedAt: 'yesterday', sentAt: at },
      { email: 'sam@example.com', attemptedAt: at, sentAt: 'later' },
      { email: 'sam@example.com', attemptedAt: at, sentAt: at, extra: true },
    ]) {
      expect(SETTINGS.operator_confirmation.parse(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts only the shipped routes', () => {
    for (const route of ['app', 'signal', 'sms', 'slack'] as const) {
      expect(SETTINGS.messaging_route.parse(route)).toEqual(ok(route));
    }
    for (const route of ['app', 'signal'] as const) {
      expect(SETTINGS.voice_route.parse(route)).toEqual(ok(route));
    }
    expect(SETTINGS.messaging_route.parse('fax').ok).toBe(false);
    // Voice does not offer SMS: the Setup page does not either.
    expect(SETTINGS.voice_route.parse('sms').ok).toBe(false);
  });

  it('accepts a parseable timestamp and normalizes it to ISO', () => {
    expect(SETTINGS['setup.completed_at'].parse('2026-01-01T00:00:00.000Z')).toEqual(
      ok('2026-01-01T00:00:00.000Z'),
    );
    expect(SETTINGS['setup.completed_at'].parse('2026-01-01T00:00:00+00:00')).toEqual(
      ok('2026-01-01T00:00:00.000Z'),
    );
    expect(SETTINGS['setup.completed_at'].parse('yesterday').ok).toBe(false);
    expect(SETTINGS['setup.completed_at'].parse(1_767_225_600_000).ok).toBe(false);
  });

  it('knows its own keys and nothing else', () => {
    expect(isSettingKey('operator')).toBe(true);
    expect(isSettingKey('not.a.key')).toBe(false);
    expect(isSettingKey('toString')).toBe(false);
  });
});

describe('settings store — reads', () => {
  it('rejects an unknown key at runtime, even when the type checker was bypassed', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const { logger } = fakeLogger();
    await expect(
      getSetting(db, 'not.a.key' as unknown as 'operator', logger),
    ).rejects.toBeInstanceOf(UnknownSettingError);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('logs a stored value that fails its schema and reads it as unset', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ key: 'messaging_route', value: 'carrier-pigeon' }] })) };
    const { logger, error } = fakeLogger();
    expect(await getSetting(db, 'messaging_route', logger)).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ settingKey: 'messaging_route' }),
      expect.stringContaining('treating it as unset'),
    );
  });

  it('reads a missing key as unset without logging', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const { logger, error } = fakeLogger();
    expect(await getSetting(db, 'voice_route', logger)).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('reads the writer alongside the value', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [{ key: 'setup.completed_at', value: '2026-01-01T00:00:00.000Z', updated_by: 'migration:132' }],
      })),
    };
    const { logger } = fakeLogger();
    await expect(getSettingRecords(db, ['setup.completed_at'], logger)).resolves.toEqual({
      'setup.completed_at': { value: '2026-01-01T00:00:00.000Z', updatedBy: 'migration:132' },
    });
  });
});

describe('settings store — writes', () => {
  it('refuses an invalid value before touching the database', async () => {
    const { pool } = fakePool();
    const { logger } = fakeLogger();
    await expect(
      setSetting(pool, 'voice_route', 'sms' as unknown as 'app', 'test', logger),
    ).rejects.toBeInstanceOf(InvalidSettingError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('writes the value and its history row in one transaction', async () => {
    const { pool, statements } = fakePool();
    const { logger } = fakeLogger();
    await setSetting(pool, 'messaging_route', 'signal', 'console', logger);

    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.some((s) => s.startsWith('INSERT INTO settings '))).toBe(true);
    expect(statements.some((s) => s.startsWith('INSERT INTO settings_history'))).toBe(true);
    // The key is locked under the transaction, and the prior value is read for the history.
    expect(statements.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.some((s) => s.includes('FOR UPDATE'))).toBe(true);
  });

  it('locks a multi-key write in sorted order, so two writes cannot deadlock', async () => {
    const { pool, lockedKeys, statements } = fakePool();
    const { logger } = fakeLogger();
    await writeSettings(
      pool,
      [{ key: 'voice_route', value: 'signal' }, { key: 'messaging_route', value: 'app' }],
      'console',
      logger,
    );
    expect(lockedKeys).toEqual(['settings:messaging_route', 'settings:voice_route']);
    expect(statements.some((s) => s.includes('hashtextextended'))).toBe(true);
  });

  it('appends one history row per key in a multi-key write', async () => {
    const { pool, statements } = fakePool();
    const { logger } = fakeLogger();
    await writeSettings(
      pool,
      [{ key: 'messaging_route', value: 'app' }, { key: 'voice_route', value: 'signal' }],
      'console',
      logger,
    );
    expect(statements.filter((s) => s.startsWith('INSERT INTO settings_history'))).toHaveLength(2);
  });

  it('does not rewrite an unchanged value', async () => {
    const { pool, statements } = fakePool({
      existing: [{ key: 'messaging_route', value: 'app', updated_by: 'console' }],
    });
    const { logger } = fakeLogger();
    await setSetting(pool, 'messaging_route', 'app', 'console', logger);

    expect(statements.some((s) => s.startsWith('INSERT INTO settings '))).toBe(false);
    expect(statements.some((s) => s.startsWith('INSERT INTO settings_history'))).toBe(false);
  });

  it('rolls back and rethrows when the history write fails', async () => {
    const { pool, statements } = fakePool({ failOn: 'settings_history' });
    const { logger } = fakeLogger();
    await expect(setSetting(pool, 'messaging_route', 'signal', 'console', logger)).rejects.toThrow(
      'history write failed',
    );
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('writes once when the key is absent, and not again when it is present', async () => {
    const absent = fakePool();
    const { logger } = fakeLogger();
    await expect(
      setSettingIfAbsent(absent.pool, 'setup.completed_at', '2026-01-01T00:00:00.000Z', 'console', logger),
    ).resolves.toBe(true);

    const present = fakePool({
      existing: [{ key: 'setup.completed_at', value: '2026-01-01T00:00:00.000Z', updated_by: 'console' }],
    });
    await expect(
      setSettingIfAbsent(present.pool, 'setup.completed_at', '2026-02-02T00:00:00.000Z', 'console', logger),
    ).resolves.toBe(false);
    expect(present.statements.some((s) => s.startsWith('INSERT INTO settings '))).toBe(false);
  });

  it('replaces a stored value that fails its schema, rather than treating it as set', async () => {
    const pool = fakePool({
      existing: [{ key: 'setup.completed_at', value: 'not-a-timestamp', updated_by: 'psql' }],
    });
    const { logger } = fakeLogger();
    await expect(
      setSettingIfAbsent(pool.pool, 'setup.completed_at', '2026-01-01T00:00:00.000Z', 'console', logger),
    ).resolves.toBe(true);
    expect(pool.statements.some((s) => s.startsWith('INSERT INTO settings '))).toBe(true);
  });

  it('requires an actor for the history row', async () => {
    const { pool } = fakePool();
    const { logger } = fakeLogger();
    await expect(setSetting(pool, 'messaging_route', 'signal', '   ', logger)).rejects.toThrow(/updatedBy/);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
