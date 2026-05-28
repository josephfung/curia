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
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

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
          '<body style="font-family:system-ui;padding:2rem">' +
          '<p>Console not built. Run: <code>pnpm build:console</code></p></body></html>',
        );
    });
    return;
  }

  // Register @fastify/static to serve files from dist/.
  // wildcard: false — we manage the catch-all route below.
  await app.register(fastifyStatic, {
    root: consoleDist,
    wildcard: false,
  });

  // SPA fallback: any GET path not resolved to a real file in dist/ → index.html.
  // This supports client-side routes like /login and any future /route paths.
  app.get<{ Params: { '*': string } }>('/*', async (req, reply) => {
    const urlPath = req.params['*'] ?? '';

    // Try to serve a real file (assets, favicon, manifest, etc.).
    if (urlPath) {
      const absPath = join(consoleDist, urlPath);
      try {
        const s = await stat(absPath);
        if (s.isFile()) return reply.sendFile(urlPath);
      } catch (err) {
        // ENOENT = path doesn't exist in dist/ — expected, fall through to SPA fallback.
        // Any other error (EACCES, EMFILE, etc.) is a real filesystem problem; re-throw
        // so Fastify's error handler returns a 500 and logs it.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    // Serve index.html for root and all client-side routes.
    return reply.sendFile('index.html');
  });
};
