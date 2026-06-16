// security-headers.ts — baseline security response headers for the HTTP API.
import type { FastifyInstance } from 'fastify';

/**
 * Set baseline security headers on every HTTP response.
 *
 * Uses an `onSend` hook, not `onRequest`. `onSend` runs for *every* reply that is sent —
 * including ones short-circuited by an earlier plugin's `onRequest` hook, which a later
 * `onRequest` hook would miss. That matters because `@fastify/cors` (preflight OPTIONS
 * responses) and `@fastify/rate-limit` (429 rejections) terminate the request in their
 * own `onRequest` hooks before any hook we register afterwards runs. `onSend` fires
 * before headers are flushed, so `reply.header()` still applies; the payload is returned
 * unchanged.
 *
 * Currently sets `X-Content-Type-Options: nosniff`, which tells browsers not to
 * MIME-sniff a response away from its declared Content-Type. It's cheap and correct even
 * for a pure JSON API (it also covers the static console assets), and it clears the ZAP
 * DAST baseline finding for rule 10021 (X-Content-Type-Options Header Missing). See #568.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
}
