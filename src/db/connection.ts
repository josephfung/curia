import pg from 'pg';
import type { Logger } from '../logger.js';
import { DEFAULT_CONNECTION_TIMEOUT_MS, isDbUnavailableError } from './resilience.js';

const { Pool } = pg;

// Re-export the pg Pool and PoolClient types so callers don't need to import pg directly.
// This keeps the rest of the codebase decoupled from the pg driver's type surface.
export type DbPool = pg.Pool;
export type DbPoolClient = pg.PoolClient;

export interface CreatePoolOptions {
  /**
   * Max ms to wait when checking out a client from the pool. Default 5000.
   * Without this, a dead Postgres can hang callers indefinitely (#1381).
   */
  connectionTimeoutMillis?: number;
}

/**
 * Create a managed connection pool to Postgres.
 *
 * We use a Pool rather than a single Client so that concurrent queries
 * from different layers (audit logger, memory engine, etc.) can proceed
 * in parallel without queuing behind each other.
 *
 * The 'error' handler is required: without it, an idle-client error from pg
 * would be an unhandled EventEmitter exception and crash the process.
 *
 * connectionTimeoutMillis ensures connection acquire failures surface to
 * callers as rejected promises instead of silent hangs (#1381).
 *
 * Note: this bounds pool checkout only — a connection that hangs mid-query
 * (half-alive server, lock wait) still needs a future `statement_timeout` /
 * `query_timeout` policy. Out of scope for #1381.
 */
export function createPool(
  databaseUrl: string,
  logger: Logger,
  options: CreatePoolOptions = {},
): DbPool {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis:
      options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  });

  pool.on('error', (err) => {
    // Log but do not re-throw — pool errors on idle clients are not fatal
    // (e.g., Postgres server restarted). pg will reconnect on the next query.
    // Classify so operators can grep DATABASE_UNAVAILABLE in structured logs.
    const unavailable = isDbUnavailableError(err);
    logger.error(
      { err, dbUnavailable: unavailable },
      unavailable
        ? 'Database pool idle-client error — Postgres may be unavailable'
        : 'Unexpected database pool error',
    );
  });

  return pool;
}
