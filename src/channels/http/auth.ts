// auth.ts — bearer token authentication for the HTTP API.
//
// When API_TOKEN is configured, all HTTP requests must include
// an Authorization header with a matching bearer token. When
// API_TOKEN is not set, authentication is disabled (useful for
// local development).

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../logger.js';

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
  // Mailbox sign-in links are token-authed the same way (#2361): the single-use token is the capability.
  '/api/mailbox-signin',
  // Google Workspace sign-in (#2683): status and start self-auth via assertSecret; the callback
  // is authorized by its single-use OAuth state alone.
  '/api/google-workspace',
  // The onboarding wizard runs in the browser with the same curia_session cookie /
  // x-web-bootstrap-secret pair as the identity routes.
  '/api/setup',
  // Starting onboarding (#2360): the console's dashboard alert and Start button, and the triage
  // hold release, authenticate the same way (assertSecret).
  '/api/onboarding',
  // The console's Operator page (#2710): assertSecret, like the Setup routes it continues.
  '/api/operator',
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

/**
 * The HTTP adapter's global auth hook (`onRequest`): bearer-token enforcement on API routes, with
 * the self-authenticating prefixes above let through to their own checks. Exported so a test can
 * put it in front of a route plugin and see what the adapter does (#2710 review).
 */
export function createBearerAuthHook(
  apiToken: string | undefined,
  logger: Pick<Logger, 'warn'>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    // routeOptions.url is the registered pattern (e.g. '/assets/index-CU1g6HdR.js' or '/*').
    // request.url is the actual request path (with query string).
    const routeUrl = request.routeOptions.url ?? '';

    // Non-API routes are the console app (static assets, SPA pages, /auth) — no bearer auth.
    //
    // @fastify/static v9 with wildcard:false scans consoleDist at startup and registers
    // an individual Fastify route per file (e.g. /assets/index-CU1g6HdR.js). These exact
    // paths don't match a '/*' check, so we gate on isApiPath() instead.
    //
    // We also check request.url as a fallback: the console '/*' catch-all absorbs GET
    // requests to unregistered paths (e.g. GET /api/nonexistent, GET /api). Without
    // the request.url check, those get routeUrl='/*', skip auth, and silently return
    // the React app HTML. Checking the actual URL keeps unregistered /api paths enforced.
    //
    // isApiPath matches '/api' exactly and '/api/...' — avoids false positives like
    // '/api-docs' while catching the bare '/api' case that startsWith('/api/') misses.
    const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');
    const requestPath = (request.url ?? '').split('?')[0] ?? '';
    if (!isApiPath(routeUrl) && !isApiPath(requestPath)) return;

    // Session-cookie, capability-token and webhook-signature routes authenticate
    // themselves and bypass bearer token enforcement. A new console route must be
    // added to the list above, or this hook rejects it before assertSecret runs.
    if (bypassesBearerAuth(routeUrl)) return;

    if (!validateBearerToken(request.headers.authorization, apiToken)) {
      // Audit-log the failure: IP, route, and whether a token was even provided.
      // Never log the token value — only that it was present and wrong vs absent.
      const reason = request.headers.authorization ? 'invalid_token' : 'missing_token';
      logger.warn({ ip: request.ip, route: routeUrl, reason }, 'HTTP auth failed');
      return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token' });
    }
  };
}
