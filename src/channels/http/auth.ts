// auth.ts — bearer token authentication for the HTTP API.
//
// When API_TOKEN is configured, all HTTP requests must include
// an Authorization header with a matching bearer token. When
// API_TOKEN is not set, authentication is disabled (useful for
// local development).

import { timingSafeEqual } from 'node:crypto';

/**
 * Validate a bearer token from an Authorization header.
 * Returns true if:
 * - No API token is configured (auth disabled)
 * - The header contains a valid Bearer token matching the configured token
 *
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateBearerToken(
  authHeader: string | undefined,
  configuredToken: string | undefined,
): boolean {
  // If no token is configured, auth is disabled
  if (!configuredToken) return true;

  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const provided = authHeader.slice('Bearer '.length);

  // Timing-safe comparison to prevent timing attacks
  if (provided.length !== configuredToken.length) return false;

  return timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(configuredToken),
  );
}
