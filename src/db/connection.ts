import pg from 'pg';
import type { Logger } from '../logger.js';

const { Pool } = pg;

// Re-export the pg Pool type so callers don't need to import pg directly.
// This keeps the rest of the codebase decoupled from the pg driver's type surface.
export type DbPool = pg.Pool;

/**
 * Create a managed connection pool to Postgres.
 *
 * We use a Pool rather than a single Client so that concurrent queries
 * from different layers (audit logger, memory engine, etc.) can proceed
 * in parallel without queuing behind each other.
 *
 * The 'error' handler is required: without it, an idle-client error from pg
 * would be an unhandled EventEmitter exception and crash the process.
 */
export function createPool(databaseUrl: string, logger: Logger): DbPool {
  const pool = new Pool({ connectionString: databaseUrl });

  pool.on('error', (err) => {
    // Log but do not re-throw — pool errors on idle clients are not fatal
    // (e.g., Postgres server restarted). pg will reconnect on the next query.
    logger.error({ err }, 'Unexpected database pool error');
  });

  return pool;
}
