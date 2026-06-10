// End-to-end-ish test of the registry routes via a real Fastify instance + RegistryService
// over a real RegistryRepo. Requires DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registryRoutes } from '../../src/channels/http/routes/registry.js';
import { RegistryRepo } from '../../src/registry/registry-repo.js';
import { RegistryService } from '../../src/registry/registry-service.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
// Skip the whole suite when DATABASE_URL is absent — this mirrors the CI gate
// used by other integration tests in this project.
const describeIf = DATABASE_URL ? describe : describe.skip;
const SECRET = 'test-bootstrap-secret';

describeIf('registry routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    // Verify the tables exist before proceeding (they're created by migrations).
    await pool.query('SELECT 1 FROM skill_registry LIMIT 0');
    await pool.query('SELECT 1 FROM agent_registry LIMIT 0');

    const skillRepo = new RegistryRepo(pool, 'skill_registry');
    const agentRepo = new RegistryRepo(pool, 'agent_registry');

    // Seed discovery with one known skill so we can exercise install/enable paths.
    const svc = new RegistryService(
      skillRepo,
      agentRepo,
      [{ name: 'alpha', metadata: { name: 'alpha', description: 'Test skill A', version: '1.0.0' } }],
      [],
    );

    // Minimal session store stub: empty Map forces header-secret auth path (no cookie).
    const sessions: Map<string, number> = new Map();

    app = Fastify();
    await app.register(cookie);
    await app.register(registryRoutes, {
      registryService: svc,
      webAppBootstrapSecret: SECRET,
      sessions,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // Reset the skill_registry table before each test to ensure isolation.
  beforeEach(async () => {
    await pool.query('DELETE FROM skill_registry');
  });

  const hdr = { 'x-web-bootstrap-secret': SECRET };

  it('401s without the secret', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/registry/skills' });
    expect(res.statusCode).toBe(401);
  });

  it('lists a discovered-but-uninstalled skill', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/registry/skills', headers: hdr });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { skills: Array<{ name: string; state: string }> };
    expect(body.skills.find(s => s.name === 'alpha')?.state).toBe('uninstalled');
  });

  it('install-enable flips it to enabled', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/skills/alpha/install-enable',
      headers: hdr,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { entry: { state: string } }).entry.state).toBe('enabled');
  });

  it('400s installing an unknown (not-on-disk) skill', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/registry/skills/nope/install',
      headers: hdr,
    });
    expect(res.statusCode).toBe(400);
  });
});
