// antfarm-assets.ts — Fastify plugin that serves LICENSED LimeZu art behind session auth.
//
// Licensed sheets must NOT be world-downloadable (LimeZu forbids redistribution), so
// unlike antfarm-static.ts (the unauthenticated /antfarm/* SPA mount) this route:
//   1. reads from apps/antfarm/assets-licensed/ — OUTSIDE the Vite public/ web root, so
//      the bytes never appear on the unauthenticated static surface;
//   2. requires a valid session (assertSecret — same check as /api/antfarm/timeline);
//   3. 404s when the file or the whole dir is absent, so the open-core image (which ships
//      no licensed art) makes the Phaser loader fall back to procedural placeholders.

import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, relative, extname } from 'node:path';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface AntfarmAssetsOptions {
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

// Only image/JSON are ever served; anything else falls through to octet-stream.
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
      throw err;
    }

    const type = CONTENT_TYPES[extname(absPath).toLowerCase()] ?? 'application/octet-stream';
    reply.type(type);
    // Licensed art is immutable per build; let authenticated browsers cache it.
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(createReadStream(absPath));
  });
};
