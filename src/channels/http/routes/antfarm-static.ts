// antfarm-static.ts — Fastify plugin that serves the apps/antfarm Vite build.
//
// Mirrors routes/console.ts but mounts under /antfarm/ so the Ant Farm SPA
// coexists with the console at /. Must register BEFORE consoleRoutes so the
// console /* wildcard does not swallow /antfarm/* requests.

import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

/** True when resolvedAbs is outside rootDir (path-traversal / absolute escape). */
function escapesRoot(rootDir: string, resolvedAbs: string): boolean {
  const rel = relative(rootDir, resolvedAbs);
  return rel === '' ? false : rel.startsWith('..') || isAbsolute(rel);
}

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
      const absPath = resolve(antfarmDist, urlPath);
      if (escapesRoot(antfarmDist, absPath)) {
        return reply.sendFile('index.html', antfarmDist);
      }
      try {
        const s = await stat(absPath);
        if (s.isFile()) {
          // Serve via the containment-checked relative path + explicit root — never the
          // raw URL param — so sendFile cannot be pointed outside antfarmDist.
          const safeRel = relative(antfarmDist, absPath);
          return reply.sendFile(safeRel, antfarmDist);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    return reply.sendFile('index.html', antfarmDist);
  });
};
