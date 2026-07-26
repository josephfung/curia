// antfarm-static.ts — Fastify plugin that serves the apps/antfarm Vite build.
//
// Mirrors routes/console.ts but mounts under /antfarm/ so the Ant Farm SPA
// coexists with the console at /. Must register BEFORE consoleRoutes so the
// console /* wildcard does not swallow /antfarm/* requests.

import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { containedStaticFile } from './static-path-guard.js';

export const antfarmStaticRoutes: FastifyPluginAsync = async (app) => {
  const antfarmDist = join(process.cwd(), 'apps', 'antfarm', 'dist');

  if (!existsSync(antfarmDist)) {
    app.get('/antfarm/*', async (_req, reply) => {
      return reply
        .status(503)
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ant Farm</title></head>' +
          '<body><p>Ant Farm not built. Run: <code>pnpm build:antfarm</code></p></body></html>',
        );
    });
    return;
  }

  await app.register(fastifyStatic, {
    root: antfarmDist,
    prefix: '/antfarm/',
    wildcard: false,
  });

  app.get<{ Params: { '*': string } }>('/antfarm/*', async (req, reply) => {
    const urlPath = req.params['*'] ?? '';

    if (urlPath) {
      // Lexical + realpath containment (rejects .. and symlink escapes). Null means
      // missing / not a file / escape — all become SPA fallback rather than probing.
      const contained = await containedStaticFile(antfarmDist, urlPath);
      if (contained) {
        return reply.sendFile(contained.safeRel, contained.rootReal);
      }
    }

    return reply.sendFile('index.html', antfarmDist);
  });
};
