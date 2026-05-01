import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('AutonomyService.getHistoryPaginated', () => {
  let pool: pg.Pool;
  let service: AutonomyService;

  beforeAll(async () => {
    if (!process.env['DATABASE_URL']) {
      throw new Error('DATABASE_URL must be set to run autonomy route integration tests');
    }
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    service = new AutonomyService(pool, logger);

    // Ensure tables exist (migration 011)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomy_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        score INTEGER NOT NULL DEFAULT 75,
        band TEXT NOT NULL DEFAULT 'approval-required',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL DEFAULT 'system'
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomy_history (
        id SERIAL PRIMARY KEY,
        score INTEGER NOT NULL,
        previous_score INTEGER,
        band TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        reason TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Seed 8 history entries for pagination testing
    await pool.query('DELETE FROM autonomy_history');
    await pool.query('DELETE FROM autonomy_config');
    await pool.query(
      `INSERT INTO autonomy_config (id, score, band, updated_by) VALUES (1, 80, 'spot-check', 'test')`
    );
    for (let i = 1; i <= 8; i++) {
      // Compute the timestamp in JavaScript so we can pass it as a parameter
      // rather than interpolating into the SQL string (policy: parameterized queries only)
      const changedAt = new Date(Date.now() - (9 - i) * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO autonomy_history (score, previous_score, band, changed_by, reason, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [50 + i * 5, 50 + (i - 1) * 5, 'approval-required', 'test', `Change ${i}`, changedAt]
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns rows and total count with default limit/offset', async () => {
    const result = await service.getHistoryPaginated();
    expect(result.total).toBe(8);
    expect(result.rows.length).toBe(5); // default limit
    // Newest first
    expect(result.rows[0]!.reason).toBe('Change 8');
  });

  it('respects custom limit and offset', async () => {
    const result = await service.getHistoryPaginated(3, 2);
    expect(result.total).toBe(8);
    expect(result.rows.length).toBe(3);
    expect(result.rows[0]!.reason).toBe('Change 6'); // offset 2 from newest
  });

  it('returns empty rows when offset exceeds total', async () => {
    const result = await service.getHistoryPaginated(5, 100);
    expect(result.total).toBe(8);
    expect(result.rows.length).toBe(0);
  });
});
