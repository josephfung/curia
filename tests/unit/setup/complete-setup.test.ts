import { describe, it, expect, vi } from 'vitest';
import { completeSetup } from '../../../src/setup/complete-setup.js';
import { createSilentLogger } from '../../../src/logger.js';

const OPTIONS = { updatedBy: 'test', logger: createSilentLogger() };

/** A pool whose settings read returns `stored`, and whose transaction records its statements. */
function fakePool(stored: Array<{ key: string; value: unknown }> = []) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes('SELECT value FROM settings')) {
        const key = String(params?.[0]);
        return { rows: stored.filter((row) => row.key === key) };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    statements,
    pool: {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM settings')) return { rows: stored };
        return { rows: [] };
      }),
      connect: vi.fn(async () => client),
    },
  };
}

describe('completeSetup', () => {
  it('stores setup.completed_at with its history row, and leaves the web thread alone', async () => {
    const { pool, statements } = fakePool();
    await completeSetup(pool, OPTIONS);

    const sql = statements.join('\n');
    expect(sql).toContain('INSERT INTO settings');
    expect(sql).toContain('settings_history');
    expect(sql).not.toContain('web_thread');
    expect(statements.some((s) => s === 'BEGIN')).toBe(true);
    expect(statements.some((s) => s === 'COMMIT')).toBe(true);
  });

  it('is idempotent: a completed Setup keeps its time and writes nothing', async () => {
    const { pool, statements } = fakePool([
      { key: 'setup.completed_at', value: '2026-01-01T00:00:00.000Z' },
    ]);
    await completeSetup(pool, OPTIONS);
    expect(statements.some((s) => s.includes('INSERT INTO settings'))).toBe(false);
  });
});
