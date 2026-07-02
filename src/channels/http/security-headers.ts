// security-headers.ts — baseline security response headers for the HTTP API.
import type { FastifyInstance } from 'fastify';

/**
 * Strict Content-Security-Policy for the console SPA (served as text/html).
 *
 * The legacy KG standalone HTML that loaded Tailwind from cdn.tailwindcss.com was
 * removed when the React console shipped; Vite pre-builds CSS/JS under /assets/.
 * This policy locks script execution to same-origin bundles and allows Google Fonts
 * for the typefaces linked from index.html.
 *
 * `style-src-attr 'unsafe-inline'` is required for React's `style={{…}}` props.
 * Scripts remain strict (`script-src 'self'`) — the main XSS mitigation goal of #130.
 */
export const CONSOLE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function isHtmlResponse(reply: { getHeader(name: string): unknown }): boolean {
  const raw = reply.getHeader('content-type');
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.toLowerCase().includes('text/html');
}

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
 * Always sets `X-Content-Type-Options: nosniff`, which tells browsers not to
 * MIME-sniff a response away from its declared Content-Type. It's cheap and correct even
 * for a pure JSON API (it also covers the static console assets), and it clears the ZAP
 * DAST baseline finding for rule 10021 (X-Content-Type-Options Header Missing). See #568.
 *
 * HTML document responses (the console SPA and its fallback pages) also receive a strict
 * Content-Security-Policy and `X-Frame-Options: DENY`. See #130.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (isHtmlResponse(reply)) {
      reply.header('Content-Security-Policy', CONSOLE_CONTENT_SECURITY_POLICY);
      reply.header('X-Frame-Options', 'DENY');
    }
    return payload;
  });
}
