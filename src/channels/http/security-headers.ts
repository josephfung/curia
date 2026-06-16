// security-headers.ts — baseline security response headers for the HTTP API.
import type { FastifyInstance } from 'fastify';

/**
 * Set baseline security headers on every HTTP response.
 *
 * Register this BEFORE the auth hook so the header is applied even on responses that a
 * later onRequest hook short-circuits (Fastify stops running subsequent hooks once one
 * sends a reply, so a header set by an earlier hook is the only one that survives a 401).
 *
 * Currently sets `X-Content-Type-Options: nosniff`, which tells browsers not to
 * MIME-sniff a response away from its declared Content-Type. It's cheap and correct even
 * for a pure JSON API (it also covers the static console assets), and it clears the ZAP
 * DAST baseline finding for rule 10021 (X-Content-Type-Options Header Missing). See #568.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
  });
}
