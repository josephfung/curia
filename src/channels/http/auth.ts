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
  // Reject empty token immediately — "Bearer " with no value is always invalid
  // and avoids a misleading length-match if configuredToken were ever empty.
  if (!provided) return false;

  // Timing-safe comparison to prevent timing attacks
  if (provided.length !== configuredToken.length) return false;

  return timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(configuredToken),
  );
}

/**
 * API route prefixes that authenticate themselves (session cookie /
 * x-web-bootstrap-secret via assertSecret, a capability token, or a webhook
 * signature) and so bypass the adapter's global bearer-token hook. A console
 * route missing from here is rejected by that hook before assertSecret runs, so
 * the browser sees "provide a valid Bearer token" (#2285's /api/activity).
 */
const SELF_AUTHED_API_PREFIXES = [
  '/api/kg',
  // Console CRUD moved off /api/kg/* (#872) — each prefix self-auths via assertSecret.
  '/api/tasks',
  '/api/contacts',
  '/api/chat',
  '/api/sessions',
  '/api/pairing',
  '/api/push',
  '/api/grant-recommendations',
  '/api/voice',
  '/api/identity',
  '/api/executive',
  '/api/jobs',
  '/api/antfarm',
  '/api/activity',
  '/api/dashboard',
  '/api/autonomy',
  '/api/memory',
  '/api/documents',
  '/api/system',
  '/api/registry',
  '/api/vault',
  // Secret-capture routes are token-authed (the single-use token in the URL is the
  // capability), so they bypass bearer auth and self-authorize via the token (#971).
  '/api/secret-capture',
  // The onboarding wizard runs in the browser with the same curia_session cookie /
  // x-web-bootstrap-secret pair as the identity routes.
  '/api/setup',
  // Telnyx SMS webhooks authenticate via Ed25519 signature, not bearer token (ADR-036).
  '/api/webhooks/telnyx',
];

/**
 * True when the registered route URL skips bearer enforcement (see SELF_AUTHED_API_PREFIXES).
 * Match on a path-segment boundary so `/api/chat` does not exempt `/api/chat-export`
 * (and likewise for tasks/contacts/… — #872 review).
 */
export function bypassesBearerAuth(routeUrl: string): boolean {
  if (routeUrl === '/api/health') return true;
  return SELF_AUTHED_API_PREFIXES.some(
    (p) => routeUrl === p || routeUrl.startsWith(`${p}/`),
  );
}
