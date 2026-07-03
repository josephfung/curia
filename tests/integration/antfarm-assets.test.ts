import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { antfarmAssetsRoutes } from '../../src/channels/http/routes/antfarm-assets.js';

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'antfarm-assets');
const ASSETS_DIR = join(FIXTURE_ROOT, 'apps', 'antfarm', 'assets-licensed', 'limezu');

describe('Ant Farm licensed-asset routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await mkdir(ASSETS_DIR, { recursive: true });
    // 1x1 PNG bytes are fine — we only assert content-type + status, not decode.
    await writeFile(join(ASSETS_DIR, 'office.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    process.chdir(FIXTURE_ROOT);
    app = Fastify();
    await app.register(antfarmAssetsRoutes, { webAppBootstrapSecret: 'secret', sessions: new Map() });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.chdir(REPO_ROOT);
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/antfarm/assets/limezu/office.png' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the PNG with the bootstrap-secret header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/antfarm/assets/limezu/office.png',
      headers: { 'x-web-bootstrap-secret': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('returns 404 for a missing asset (open-core has no art)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/antfarm/assets/limezu/missing.png',
      headers: { 'x-web-bootstrap-secret': 'secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('blocks path traversal with 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/antfarm/assets/..%2f..%2f..%2f..%2fpackage.json',
      headers: { 'x-web-bootstrap-secret': 'secret' },
    });
    expect(res.statusCode).toBe(404);
  });
});
