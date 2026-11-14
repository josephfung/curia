import { describe, it, expect, vi } from 'vitest';
import { repairStoredTimezones } from '../../../src/contacts/timezone-repair.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { Logger } from '../../../src/logger.js';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

function makePool(rows: Array<{ id: string; timezone: string }>) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.startsWith('SELECT')) return { rows };
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query } as unknown as DbPool, query };
}

describe('repairStoredTimezones', () => {
  it('rewrites a label that maps to one zone, guarded on the old value', async () => {
    const { pool, query } = makePool([{ id: 'c1', timezone: 'Eastern Time - Toronto' }]);
    const logger = makeLogger();

    const result = await repairStoredTimezones(pool, logger);

    expect(result).toEqual({ repaired: 1, unrecognized: 0 });
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE'));
    expect(update).toBeDefined();
    // Parameterized, and only if the row still holds the value we read (no lost update).
    expect(update![1]).toEqual(['America/Toronto', 'c1', 'Eastern Time - Toronto']);
    expect(String(update![0])).toMatch(/WHERE id = \$2 AND timezone = \$3/);
  });

  it('leaves valid zones alone', async () => {
    const { pool, query } = makePool([{ id: 'c1', timezone: 'America/Toronto' }, { id: 'c2', timezone: 'UTC' }]);

    const result = await repairStoredTimezones(pool, makeLogger());

    expect(result).toEqual({ repaired: 0, unrecognized: 0 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
  });

  it('warns about a value with no single zone and does not change it', async () => {
    const { pool, query } = makePool([{ id: 'c2', timezone: 'Eastern Time - US & Canada' }]);
    const logger = makeLogger();

    const result = await repairStoredTimezones(pool, logger);

    expect(result).toEqual({ repaired: 0, unrecognized: 1 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contactIds: ['c2'] }),
      expect.stringMatching(/not a recognized timezone/),
    );
  });

  it('is silent when there is nothing to repair', async () => {
    const { pool } = makePool([]);
    const logger = makeLogger();

    await repairStoredTimezones(pool, logger);

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
