// antfarm-assets.ts — Fastify plugin that serves LICENSED LimeZu art behind session auth.
//
// The LimeZu sheets now live in-repo (apps/antfarm/assets-licensed/limezu/ — LimeZu granted
// redistribution) and ship in the open-core image. We still keep them off the unauthenticated
// static surface: unlike antfarm-static.ts (the unauthenticated /antfarm/* SPA mount) this route:
//   1. reads from apps/antfarm/assets-licensed/ — OUTSIDE the Vite public/ web root, so
//      the bytes never appear on the unauthenticated static surface;
//   2. requires an authenticated caller — a valid session cookie, or the
//      x-web-bootstrap-secret header for programmatic access (assertSecret — same
//      check as /api/antfarm/timeline);
//   3. 404s when the file or the whole dir is absent, so a build that omits the art (e.g. a
//      source checkout without the assets) makes the Phaser loader fall back to procedural
//      placeholders instead of erroring.

import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, relative, extname } from 'node:path';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface AntfarmAssetsOptions {
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

// Strict allowlist: these are the ONLY content types this route will ever emit. Any other
// extension 404s (see below) rather than being served as a guessable/sniffable stream. This is
// the primary defense against the XSS class Semgrep flags here (direct-response-write): the byte
// stream can never be labelled text/html, and paired with the X-Content-Type-Options: nosniff
// header on the response, the browser can't sniff it into one either.
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
};

export const antfarmAssetsRoutes: FastifyPluginAsync<AntfarmAssetsOptions> = async (app, opts) => {
  const { webAppBootstrapSecret, sessions } = opts;
  // Resolved once at registration; process.cwd() is /app in the container, repo root in dev.
  const assetsRoot = join(process.cwd(), 'apps', 'antfarm', 'assets-licensed');

  app.get<{ Params: { '*': string } }>('/api/antfarm/assets/*', async (req, reply) => {
    if (!assertSecret(req, reply, webAppBootstrapSecret, sessions)) return;

    const urlPath = req.params['*'] ?? '';
    if (!urlPath) return reply.status(404).send({ error: 'Not found' });

    const absPath = resolve(assetsRoot, urlPath);
    // Reject any path that escapes assetsRoot (path traversal).
    if (relative(assetsRoot, absPath).startsWith('..')) {
      return reply.status(404).send({ error: 'Not found' });
    }

    try {
      const s = await stat(absPath);
      if (!s.isFile()) return reply.status(404).send({ error: 'Not found' });
    } catch (err) {
      // Missing file OR missing assets-licensed dir (open-core) → 404 → placeholders.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.status(404).send({ error: 'Not found' });
      }
      // Anything else (EACCES, EMFILE, …) is a real fault, not the open-core absent-art path:
      // log with context before propagating so Fastify's error handler can turn it into a 500
      // that's actually diagnosable on-call, instead of an anonymous stack trace.
      req.log.error({ err, absPath }, 'antfarm-assets: unexpected fs error serving licensed asset');
      throw err;
    }

    // Strict allowlist — only known-safe types are served. Unknown extensions 404 rather than
    // falling back to octet-stream, so the response body is never a stream of unknown provenance.
    const type = CONTENT_TYPES[extname(absPath).toLowerCase()];
    if (!type) return reply.status(404).send({ error: 'Not found' });
    reply.type(type);
    // Defense-in-depth against MIME sniffing: forbid the browser from re-interpreting the body
    // (e.g. sniffing a PNG's bytes as text/html and executing embedded script). This is the
    // response-side half of the XSS mitigation for direct-response-write.
    reply.header('X-Content-Type-Options', 'nosniff');
    // Licensed art is immutable per build; let authenticated browsers cache it.
    reply.header('Cache-Control', 'private, max-age=86400');
    // Semgrep direct-response-write flags streaming a user-derived path to the response as XSS.
    // Not applicable here: this streams binary image bytes (never templated HTML), the path is
    // traversal-guarded and constrained to build-shipped licensed art, the request is session-
    // authed, the Content-Type is a strict png/json allowlist (never text/html), and nosniff is
    // set above so the body can't be sniffed into an executable type. `resp.render()` (the rule's
    // suggested fix) is for HTML templates and does not apply to a binary file stream.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(createReadStream(absPath));
  });
};
