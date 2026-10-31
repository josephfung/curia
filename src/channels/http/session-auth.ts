// session-auth.ts — Shared session authentication helper for HTTP routes.
//
// Both the KG routes and the identity routes accept authentication via either:
//   1. A valid `curia_session` HttpOnly cookie (set by POST /auth)
//   2. A valid `x-web-bootstrap-secret` request header (for programmatic access)
//
// The sessions Map is created in HttpAdapter and passed to both route registrations.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * One live session in the in-memory map. `renewedAt` is the last time the idle
 * window was written (login or a throttled renewal) and anchors the next write.
 * A bare number is accepted so older tests can keep storing just an expiry.
 */
export interface SessionEntry {
  /** Epoch ms. A request at or after this instant is rejected. */
  expiresAt: number;
  /** Epoch ms of the last expiry write. */
  renewedAt: number;
  /** sessions.id. Absent when a test planted only an expiry. */
  id?: string;
}

export type SessionStoreValue = SessionEntry | number;

// token hash → expiry. Lives in HttpAdapter, shared across route registrations.
// Map keys are SHA-256 hashes of the raw token so the plaintext never touches the DB.
export type SessionStore = Map<string, SessionStoreValue>;

export function sessionExpiresAt(value: SessionStoreValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : value.expiresAt;
}

/** Slides the idle window. Bound per store so route handlers stay unchanged. */
export interface SessionRenewer {
  touch(tokenHash: string, rawToken: string, reply: FastifyReply): void;
}

const sessionRenewers = new WeakMap<SessionStore, SessionRenewer>();

export function bindSessionRenewer(sessions: SessionStore, renewer: SessionRenewer): void {
  sessionRenewers.set(sessions, renewer);
}

/**
 * Shared per-route rate limit for console session-authed APIs (KG, tasks, contacts,
 * chat, dashboard, …): 60/min per IP. Kept in one place so the cap cannot drift
 * across route files (#872 review).
 */
export const CONSOLE_RATE = {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
} as const;

/**
 * SHA-256 hash of a session token. Used as the Map key and the DB column value so the
 * raw 256-bit token stays only in the HttpOnly cookie and is never persisted anywhere.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The raw `curia_session` cookie, or null when the request has none. */
export function readSessionCookie(request: FastifyRequest): string | null {
  const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies;
  const token = cookies?.['curia_session'];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Timing-safe string comparison using Buffer byte lengths.
 * Returns true only when a and b are byte-for-byte identical.
 *
 * Why byteLength not charLength: a multi-byte UTF-8 secret can have the same char count
 * as a different-byte-length string, causing timingSafeEqual to throw a RangeError if
 * the char-count guard passes but byte lengths differ.
 */
export function compareSecrets(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify that the request is authenticated via session cookie or bootstrap secret header.
 *
 * Returns true if authenticated. Returns false and sends an error response if not.
 *
 * Why timingSafeEqual: prevents character-by-character brute force against the secret.
 * We compare byte lengths before calling it because timingSafeEqual throws if buffers
 * differ in length.
 */
export function assertSecret(
  request: FastifyRequest,
  reply: FastifyReply,
  configuredSecret: string | undefined,
  sessions: SessionStore,
): boolean {
  if (!configuredSecret) {
    reply.status(503).send({
      error: 'Web UI is disabled. Set WEB_APP_BOOTSTRAP_SECRET in .env to enable it.',
    });
    return false;
  }

  // Primary path: browser session cookie set by POST /auth.
  // @fastify/cookie augments FastifyRequest with .cookies at runtime.
  const sessionToken = readSessionCookie(request);
  if (sessionToken) {
    // Hash before lookup — the Map is keyed by SHA-256(token), matching what was stored.
    const tokenHash = hashToken(sessionToken);
    const expiresAt = sessionExpiresAt(sessions.get(tokenHash));
    if (expiresAt !== undefined && Date.now() < expiresAt) {
      sessionRenewers.get(sessions)?.touch(tokenHash, sessionToken, reply);
      return true;
    }
    // Expired or unknown token — fall through to header check below.
  }

  // Fallback: direct header (programmatic access via curl / scripts).
  // Reject non-string values (Fastify coerces duplicate headers to string[]).
  const provided = request.headers['x-web-bootstrap-secret'];
  if (typeof provided !== 'string') {
    reply.status(401).send({
      error: 'Unauthorized. Authenticate via POST /auth or provide the x-web-bootstrap-secret header.',
    });
    return false;
  }
  if (!compareSecrets(provided, configuredSecret)) {
    reply.status(401).send({
      error: 'Unauthorized. Authenticate via POST /auth or provide the x-web-bootstrap-secret header.',
    });
    return false;
  }

  return true;
}
