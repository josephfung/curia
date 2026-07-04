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

/**
 * CSP for the Ant Farm page (`/antfarm/*`, served as text/html).
 *
 * Identical to the console policy except `img-src` also allows `data:` and `blob:`. The
 * Ant Farm visualization runs Phaser, which needs both:
 *   - `data:` — Phaser loads its internal boot textures (`__DEFAULT`, `__MISSING`,
 *     `__WHITE`) from embedded base64 `data:` PNG URIs on startup. `__WHITE` backs all
 *     tinting/graphics, so without this the WebGL canvas fails to render at all.
 *   - `blob:` — Phaser's file loader fetches real image assets (the licensed LimeZu
 *     tilesets/singles/character sheets served from `/api/antfarm/assets/*`) via XHR and
 *     hands the response to an `Image` element as an `URL.createObjectURL(blob)` `blob:`
 *     URL. Same-origin `'self'` does NOT cover the `blob:` scheme, so without this every
 *     real-art load is blocked ("Loading the image 'blob:…' violates … img-src") → the
 *     loader errors → the office silently falls back to procedural placeholders. This is
 *     the half the #1337 boot-texture fix missed; the office renders but stays placeholder.
 *
 * Neither `data:` nor `blob:` in `img-src` can execute script, so `script-src 'self'` —
 * the XSS mitigation that motivated #130 — is unchanged. Only image sources are relaxed,
 * and only on this page.
 */
export const ANTFARM_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
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
 * True when the request targets the Ant Farm SPA. Match only the `/antfarm/` prefix (with
 * the trailing slash) — that is exactly what the antfarm-static plugin serves (`prefix:
 * '/antfarm/'` plus the `/antfarm/*` fallback), and deep links into the SPA all carry it.
 *
 * Bare `/antfarm` (no slash) is deliberately NOT matched: no Ant Farm route handles it, so
 * it falls through to the console's `/*` wildcard and is served the *console* index.html.
 * Matching it here would hand that console page the relaxed `data:` CSP — the exact leak
 * this scoping exists to prevent. Fastify's `request.url` is the raw, un-decoded path and
 * includes any query string, so strip the query and compare the path only.
 */
function isAntfarmRequest(url: string): boolean {
  // split always yields at least one element, so [0] is guaranteed present.
  const path = url.split('?', 1)[0]!;
  return path.startsWith('/antfarm/');
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
 * Content-Security-Policy and `X-Frame-Options: DENY`. See #130. The Ant Farm page gets a
 * near-identical policy that additionally allows `img-src ... data:` for Phaser's base64
 * boot textures; every other HTML response keeps the stricter console policy.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (isHtmlResponse(reply)) {
      const csp = isAntfarmRequest(request.url)
        ? ANTFARM_CONTENT_SECURITY_POLICY
        : CONSOLE_CONTENT_SECURITY_POLICY;
      reply.header('Content-Security-Policy', csp);
      reply.header('X-Frame-Options', 'DENY');
    }
    return payload;
  });
}
