/**
 * Unit tests for WorkingMemory TTL — issue #220.
 *
 * Verifies:
 *   - expires_at is populated in INSERT when ttlDays is configured
 *   - expires_at is NULL in INSERT when ttlDays is omitted
 *   - purgeExpired() issues the right DELETE and returns rowCount
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import type { DbPool } from '../../../src/db/connection.js';

// ---------------------------------------------------------------------------
// Minimal mock pool builder
// ---------------------------------------------------------------------------

type QueryResult = { rows: unknown[]; rowCount?: number };

function buildSimplePool(
  handler: (sql: string, params?: unknown[]) => QueryResult,
): DbPool {
  return {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) =>
      Promise.resolve(handler(sql, params)),
    ),
    connect: vi.fn(),
  } as unknown as DbPool;
}

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkingMemory — TTL', () => {
  const CONV = 'conv-ttl';
  const AGENT = 'coordinator';

  describe('addTurn() — expires_at', () => {
    it('populates expires_at when ttlDays is set', async () => {
      let capturedParams: unknown[] | undefined;

      const pool = buildSimplePool((sql, params) => {
        if (sql.includes('INSERT INTO working_memory')) {
          capturedParams = params;
        }
        return { rows: [] };
      });

      const memory = WorkingMemory.createWithPostgres(pool, silentLogger(), undefined, 30);
      const before = Date.now();
      await memory.addTurn(CONV, AGENT, { role: 'user', content: 'Hello' });
      const after = Date.now();

      expect(capturedParams).toBeDefined();
      const expiresAt = capturedParams![4] as Date;
      expect(expiresAt).toBeInstanceOf(Date);
      // Should be approximately 30 days from now
      const expectedMs = 30 * 24 * 60 * 60 * 1000;
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs - 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after + expectedMs + 1000);
    });

    it('sets expires_at to NULL when ttlDays is omitted', async () => {
      let capturedParams: unknown[] | undefined;

      const pool = buildSimplePool((sql, params) => {
        if (sql.includes('INSERT INTO working_memory')) {
          capturedParams = params;
        }
        return { rows: [] };
      });

      // No ttlDays — fourth positional param omitted
      const memory = WorkingMemory.createWithPostgres(pool, silentLogger());
      await memory.addTurn(CONV, AGENT, { role: 'user', content: 'Hello' });

      expect(capturedParams).toBeDefined();
      expect(capturedParams![4]).toBeNull();
    });

    it('INSERT includes expires_at column', async () => {
      let capturedSql: string | undefined;

      const pool = buildSimplePool((sql) => {
        if (sql.includes('INSERT INTO working_memory')) {
          capturedSql = sql;
        }
        return { rows: [] };
      });

      const memory = WorkingMemory.createWithPostgres(pool, silentLogger(), undefined, 7);
      await memory.addTurn(CONV, AGENT, { role: 'user', content: 'Hello' });

      expect(capturedSql).toContain('expires_at');
    });
  });

  describe('purgeExpired()', () => {
    it('issues DELETE WHERE expires_at IS NOT NULL AND expires_at < now()', async () => {
      let capturedSql: string | undefined;

      const pool = buildSimplePool((sql) => {
        if (sql.includes('DELETE FROM working_memory')) {
          capturedSql = sql;
        }
        return { rows: [], rowCount: 0 };
      });

      const memory = WorkingMemory.createWithPostgres(pool, silentLogger());
      await memory.purgeExpired();

      expect(capturedSql).toBeDefined();
      const normalized = capturedSql!.replace(/\s+/g, ' ').trim();
      expect(normalized).toContain('DELETE FROM working_memory');
      expect(normalized).toContain('expires_at IS NOT NULL');
      expect(normalized).toContain('expires_at < now()');
    });

    it('returns the number of rows deleted', async () => {
      const pool = buildSimplePool((sql) => {
        if (sql.includes('DELETE FROM working_memory')) {
          return { rows: [], rowCount: 5 };
        }
        return { rows: [] };
      });

      const memory = WorkingMemory.createWithPostgres(pool, silentLogger());
      const deleted = await memory.purgeExpired();

      expect(deleted).toBe(5);
    });

    it('returns 0 when rowCount is undefined', async () => {
      const pool = buildSimplePool(() => ({ rows: [], rowCount: undefined }));

      const memory = WorkingMemory.createWithPostgres(pool, silentLogger());
      const deleted = await memory.purgeExpired();

      expect(deleted).toBe(0);
    });
  });

  describe('InMemoryBackend', () => {
    it('purgeExpired() returns 0 — no-op in in-memory backend', async () => {
      const memory = WorkingMemory.createInMemory();
      const deleted = await memory.purgeExpired();
      expect(deleted).toBe(0);
    });
  });
});
