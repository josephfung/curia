import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { antfarmStaticRoutes } from '../../../../src/channels/http/routes/antfarm-static.js';
import { consoleRoutes } from '../../../../src/channels/http/routes/console.js';
import { antfarmRoutes } from '../../../../src/channels/http/routes/antfarm.js';

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'antfarm-static');
const DIST_DIR = join(FIXTURE_ROOT, 'apps', 'antfarm', 'dist');

describe('Ant Farm static routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await mkdir(DIST_DIR, { recursive: true });
    await writeFile(
      join(DIST_DIR, 'index.html'),
      '<!doctype html><html><body><h1>Ant Farm</h1></body></html>',
    );
    await mkdir(join(DIST_DIR, 'assets'), { recursive: true });
    await writeFile(join(DIST_DIR, 'assets', 'app.js'), 'console.log("antfarm");');

    process.chdir(FIXTURE_ROOT);

    app = Fastify();
    await app.register(antfarmStaticRoutes);
    await app.register(antfarmRoutes, {
      auditLogRepo: null as never,
      eventRouter: { addAntfarmClient: () => () => {} } as never,
      webAppBootstrapSecret: 'secret',
      sessions: new Map(),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });
    await app.register(consoleRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.chdir(REPO_ROOT);
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('serves Ant Farm index at /antfarm/', async () => {
    const res = await app.inject({ method: 'GET', url: '/antfarm/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Ant Farm');
  });

  it('serves Ant Farm assets under /antfarm/assets/', async () => {
    const res = await app.inject({ method: 'GET', url: '/antfarm/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('antfarm');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/antfarm/deep/route' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Ant Farm');
  });

  it('rejects path traversal under /antfarm/ with SPA fallback (not filesystem escape)', async () => {
    // Derive encoded ".." segments from DIST_DIR → REPO_ROOT/package.json so the
    // request actually targets the sensitive file after process.chdir(FIXTURE_ROOT).
    // Encode ".." as "..%2f" so Fastify does not collapse the URL before routing
    // (see antfarm-assets.test.ts); the route param still decodes to "../…".
    const encoded = relative(DIST_DIR, join(REPO_ROOT, 'package.json'))
      .split('/')
      .map((seg) => (seg === '..' ? '..%2f' : encodeURIComponent(seg)))
      .join('');
    const res = await app.inject({
      method: 'GET',
      url: `/antfarm/${encoded}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Ant Farm');
    expect(res.body).not.toContain('"name": "curia"');
  });

  it('rejects a symlink inside dist that points outside the build root', async () => {
    const linkPath = join(DIST_DIR, 'escape-link');
    await symlink(join(REPO_ROOT, 'package.json'), linkPath);
    try {
      const res = await app.inject({ method: 'GET', url: '/antfarm/escape-link' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Ant Farm');
      expect(res.body).not.toContain('"name": "curia"');
    } finally {
      await rm(linkPath, { force: true });
    }
  });

  it('does not let console wildcard swallow /api/antfarm/timeline', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/antfarm/timeline' });
    expect(res.statusCode).toBe(401);
  });
});
