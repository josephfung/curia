import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { consoleRoutes } from '../../../../src/channels/http/routes/console.js';

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'console-sw-cache');
const DIST_DIR = join(FIXTURE_ROOT, 'apps', 'console', 'dist');

describe('console service worker cache header', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await mkdir(DIST_DIR, { recursive: true });
    await writeFile(join(DIST_DIR, 'index.html'), '<!doctype html><title>Curia</title>');
    await writeFile(join(DIST_DIR, 'sw.js'), 'self.addEventListener("fetch", function () {});');
    await mkdir(join(DIST_DIR, 'extra'), { recursive: true });
    await writeFile(join(DIST_DIR, 'extra', 'widget-sw.js'), 'widget');
    process.chdir(FIXTURE_ROOT);
    app = Fastify();
    await app.register(consoleRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.chdir(REPO_ROOT);
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('serves /sw.js with Cache-Control: no-cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/sw.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('addEventListener');
    expect(String(res.headers['cache-control'])).toBe('no-cache');
  });

  it('does not force no-cache on a file that merely ends in sw.js', async () => {
    const res = await app.inject({ method: 'GET', url: '/extra/widget-sw.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('widget');
    expect(String(res.headers['cache-control'] ?? '')).not.toBe('no-cache');
  });
});
