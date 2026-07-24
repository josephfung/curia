// resilience.ts — database unavailability detection and retry helpers (#1381).
//
// Spec 05: non-critical DB paths retry with backoff; critical paths bubble as
// AgentError (DATABASE_UNAVAILABLE). Classification uses pg SQLSTATE codes and
// Node system error codes — never string-matching messages.

import type { AgentError } from '../errors/types.js';
import { isRetryable } from '../errors/types.js';
import { sanitizeOutput } from '../skills/sanitize.js';

/** Default connection acquire timeout so callers fail fast instead of hanging. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/** Default probe interval for the availability monitor. */
export const DEFAULT_DB_PROBE_INTERVAL_MS = 30_000;

/** Escalate to the CEO after this continuous unavailability window. */
export const DEFAULT_DB_ESCALATION_MS = 5 * 60_000;

/** Bounded backoff for non-critical DB retries. */
export const DEFAULT_DB_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
} as const;

/**
 * Postgres SQLSTATE classes / codes that indicate the server or connection is
 * unavailable (transient). See https://www.postgresql.org/docs/current/errcodes-appendix.html
 *
 * - Class 08 — Connection Exception
 * - 57P01 — admin_shutdown
 * - 57P02 — crash_shutdown
 * - 57P03 — cannot_connect_now
 * - 53300 — too_many_connections
 */
const PG_UNAVAILABLE_CODES = new Set([
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '08P01', // protocol_violation
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

/** Node / libpq system codes that surface as connection failures. */
const NODE_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  // pg pool: no connection acquired within connectionTimeoutMillis
  'CONNECTION_STOPPED',
  'CONNECTION_ENDED',
]);

function extractCode(err: unknown): string | undefined {
  if (err === null || err === undefined || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  return undefined;
}

/**
 * True when `err` indicates Postgres / the connection pool is unavailable.
 * Does NOT treat application SQL errors (syntax, constraint, etc.) as outages.
 */
export function isDbUnavailableError(err: unknown): boolean {
  const code = extractCode(err);
  if (!code) {
    // pg wraps some connection failures as AggregateError / nested causes.
    if (err instanceof Error && 'cause' in err && err.cause !== undefined) {
      return isDbUnavailableError(err.cause);
    }
    // Pool "timeout exceeded when trying to connect" has no code in older pg —
    // match the well-known message only as a last resort for that specific shape.
    if (err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message)) {
      return true;
    }
    return false;
  }
  if (NODE_UNAVAILABLE_CODES.has(code)) return true;
  if (PG_UNAVAILABLE_CODES.has(code)) return true;
  // Class 08xxxx — any connection_exception subclass we didn't list explicitly.
  if (/^08/.test(code)) return true;
  return false;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return 'Database unavailable (no details)';
  return String(err);
}

/**
 * Build a structured AgentError for a database outage.
 * Always retryable — temporary infra failure, not a logic bug.
 */
export function createDbUnavailableAgentError(source: string, err: unknown): AgentError {
  const code = extractCode(err);
  const context: Record<string, unknown> = {};
  if (code) context.code = code;
  return {
    type: 'DATABASE_UNAVAILABLE',
    source,
    message: sanitizeOutput(extractMessage(err), { maxLength: 400 }),
    retryable: isRetryable('DATABASE_UNAVAILABLE'),
    context,
    timestamp: new Date(),
  };
}

export interface WithDbRetryOptions {
  /** Max attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Initial backoff delay in ms. Default 100. */
  baseDelayMs?: number;
  /** Cap on backoff delay. Default 1000. */
  maxDelayMs?: number;
  /** Optional sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Retry a DB operation on transient unavailability. Non-DB errors and
 * exhaustion of attempts rethrow the last error unchanged.
 *
 * Use on non-critical paths (acknowledgement writes, telemetry, summarization).
 * Critical paths should call the operation once and classify with
 * `createDbUnavailableAgentError` instead.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options: WithDbRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_DB_RETRY.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_DB_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_DB_RETRY.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isDbUnavailableError(err) || attempt >= maxAttempts) {
        throw err;
      }
      // Full-jitter exponential backoff so concurrent retryers don't stampede
      // Postgres as it recovers (base/2 … base, doubled each attempt, capped).
      const rawDelay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = rawDelay / 2 + Math.random() * (rawDelay / 2);
      await sleep(delay);
    }
  }
  // Unreachable — loop always returns or throws — but satisfies the type checker.
  throw lastErr;
}
