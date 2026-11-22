// The typed settings registry and store (#2709): each key's schema, the read that refuses
// to trust a bad stored value, and the transaction every write uses.
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
  setSetting,
  writeSettings,
} from '../../../src/settings/store.js';

const EXPECTED_KEYS = ['messaging_route', 'operator', 'setup.completed_at', 'voice_route'];

function fakeLogger(): { logger: Pick<Logger, 'error'>; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  return { logger: { error } as unknown as Pick<Logger, 'error'>, error };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

describe('settings registry', () => {
  it('declares exactly the four Setup keys, each with a purpose, a default and a parser', () => {
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
    await expect(getSetting(db, 'not.a.key' as unknown as 'operator')).rejects.toBeInstanceOf(UnknownSettingError);
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
});

describe('settings store — writes', () => {
  function fakePool(failOn?: string) {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (failOn && sql.includes(failOn)) throw new Error('history write failed');
        if (sql.includes('SELECT value FROM settings')) return { rows: [{ value: 'app' }] };
        void params;
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    return {
      statements,
      client,
      pool: {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => client),
      },
    };
  }

  it('refuses an invalid value before touching the database', async () => {
    const { pool } = fakePool();
    await expect(
      setSetting(pool, 'voice_route', 'sms' as unknown as 'app', 'test'),
    ).rejects.toBeInstanceOf(InvalidSettingError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('writes the value and its history row in one transaction', async () => {
    const { pool, statements } = fakePool();
    await setSetting(pool, 'messaging_route', 'signal', 'console');

    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.some((s) => s.startsWith('INSERT INTO settings '))).toBe(true);
    expect(statements.some((s) => s.startsWith('INSERT INTO settings_history'))).toBe(true);
    // The prior value is read under a row lock, so the history row is exact.
    expect(statements.some((s) => s.includes('FOR UPDATE'))).toBe(true);
  });

  it('appends one history row per key in a multi-key write', async () => {
    const { pool, statements } = fakePool();
    await writeSettings(
      pool,
      [{ key: 'messaging_route', value: 'app' }, { key: 'voice_route', value: 'signal' }],
      'console',
    );
    expect(statements.filter((s) => s.startsWith('INSERT INTO settings_history'))).toHaveLength(2);
  });

  it('rolls back and rethrows when the history write fails', async () => {
    const { pool, statements } = fakePool('settings_history');
    await expect(setSetting(pool, 'messaging_route', 'signal', 'console')).rejects.toThrow('history write failed');
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('requires an actor for the history row', async () => {
    const { pool } = fakePool();
    await expect(setSetting(pool, 'messaging_route', 'signal', '   ')).rejects.toThrow(/updatedBy/);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
