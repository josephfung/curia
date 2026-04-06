// session-auth.ts — Shared session authentication helper for HTTP routes.
//
// Both the KG routes and the identity routes accept authentication via either:
//   1. A valid `curia_session` HttpOnly cookie (set by POST /auth)
//   2. A valid `x-web-bootstrap-secret` request header (for programmatic access)
//
// The sessions Map is created in HttpAdapter and passed to both route registrations.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

// token → expiry timestamp in ms. Lives in HttpAdapter, shared across route registrations.
export type SessionStore = Map<string, number>;

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
  const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies;
  const sessionToken = cookies?.['curia_session'];
  if (sessionToken) {
    const expiresAt = sessions.get(sessionToken);
    if (expiresAt !== undefined && Date.now() < expiresAt) return true;
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
  // Compare byte lengths (not char lengths) before calling timingSafeEqual — it throws if
  // the two buffers differ in length. A multi-byte UTF-8 secret can have the same char count
  // but different byte length, so using Buffer.byteLength rather than String.length is correct.
  const providedBuf = Buffer.from(provided);
  const configuredBuf = Buffer.from(configuredSecret);
  if (
    providedBuf.length !== configuredBuf.length ||
    !timingSafeEqual(providedBuf, configuredBuf)
  ) {
    reply.status(401).send({
      error: 'Unauthorized. Authenticate via POST /auth or provide the x-web-bootstrap-secret header.',
    });
    return false;
  }

  return true;
}
