// console.ts — Fastify plugin that serves the apps/console Vite build.
//
// In production (Docker), apps/console/dist/ is built during the image build
// step and copied into the runtime image. Fastify serves the static files here.
//
// SPA routing: any GET path that doesn't resolve to a file in dist/ is served
// as index.html so TanStack Router can handle client-side navigation.
//
// In dev, this plugin serves the pre-built dist (if it exists). For live reload,
// run the Vite dev server separately via `pnpm dev` (concurrently starts both).

import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { containedStaticFile } from './static-path-guard.js';

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  const consoleDist = join(process.cwd(), 'apps', 'console', 'dist');

  if (!existsSync(consoleDist)) {
    // Console hasn't been built yet — serve a build hint rather than crashing.
    // Run `pnpm build:console` to produce the dist before starting Fastify.
    app.get('/*', async (_req, reply) => {
      return reply
        .status(503)
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Curia</title></head>' +
          '<body><p>Console not built. Run: <code>pnpm build:console</code></p></body></html>',
        );
    });
    return;
  }

  // Register @fastify/static to serve files from dist/.
  // wildcard: false — we manage the catch-all route below.
  await app.register(fastifyStatic, {
    root: consoleDist,
    wildcard: false,
    setHeaders(res, filePath) {
      // @fastify/static passes the Fastify reply here, which has header(), not setHeader().
      // Match the dist-root worker only. endsWith('sw.js') also matches widget-sw.js.
      if (resolve(filePath) !== join(resolve(consoleDist), 'sw.js')) return;
      const writable = res as unknown as {
        header?: (name: string, value: string) => void;
        setHeader?: (name: string, value: string) => void;
      };
      if (typeof writable.header === 'function') writable.header('Cache-Control', 'no-cache');
      else writable.setHeader?.('Cache-Control', 'no-cache');
    },
  });

  // SPA fallback: any GET path not resolved to a real file in dist/ → index.html.
  // This supports client-side routes like /login and any future /route paths.
  app.get<{ Params: { '*': string } }>('/*', async (req, reply) => {
    const urlPath = req.params['*'] ?? '';

    // Try to serve a real file (assets, favicon, manifest, etc.).
    if (urlPath) {
      // Lexical + realpath containment (rejects .. and symlink escapes). Null means
      // missing / not a file / escape — all become SPA fallback rather than probing.
      const contained = await containedStaticFile(consoleDist, urlPath);
      if (contained) {
        // The service worker must not be cached across deploys, or phones
        // keep running the previous worker and miss the update prompt.
        if (contained.safeRel === 'sw.js') {
          // @fastify/send overwrites Cache-Control unless cacheControl is off.
          const sent = reply.sendFile(contained.safeRel, contained.rootReal, { cacheControl: false });
          reply.header('Cache-Control', 'no-cache');
          return sent;
        }
        return reply.sendFile(contained.safeRel, contained.rootReal);
      }
    }

    // Serve index.html for root and all client-side routes.
    return reply.sendFile('index.html', consoleDist);
  });
};
