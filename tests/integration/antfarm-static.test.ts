import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { antfarmStaticRoutes } from '../../src/channels/http/routes/antfarm-static.js';
import { consoleRoutes } from '../../src/channels/http/routes/console.js';
import { antfarmRoutes } from '../../src/channels/http/routes/antfarm.js';

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

  it('does not let console wildcard swallow /api/antfarm/timeline', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/antfarm/timeline' });
    expect(res.statusCode).toBe(401);
  });
});
