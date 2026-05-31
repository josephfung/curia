// tests/integration/setup-routes.test.ts
//
// Integration tests for /api/setup/* endpoints (issue #771).
// Verifies authentication, validation, idempotency, and the status-flag wiring
// to setupRequiredAtBoot.
//
// Requires a running Postgres with migrations applied.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { setupRoutes } from '../../src/channels/http/routes/setup.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const TEST_SECRET = 'setup-route-test-secret';
const AUTH_HEADER = { 'x-web-bootstrap-secret': TEST_SECRET };
const TEST_LABEL_PREFIX = 'Setup-Route Test';

describeIf('/api/setup/* routes', () => {
  let pool: pg.Pool;
  const logger = createLogger('silent');

  // Two apps: one booted as setupRequiredAtBoot=true (the wizard-mode case),
  // one as false (post-restart). Both share the DB and session store so we can
  // assert the status flag responds to the boot-time value, not live state.
  let appSetupMode: FastifyInstance;
  let appNormalMode: FastifyInstance;
  // Sessions intentionally empty — tests use the bootstrap-secret header.
  const sessions: Map<string, number> = new Map();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM contacts LIMIT 0');

    const buildApp = async (setupRequiredAtBoot: boolean) => {
      const app = Fastify();
      // rate-limit plugin is required because setup routes attach { config: { rateLimit: ... } }
      // per route — without it Fastify errors on registration.
      await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
      await app.register(setupRoutes, {
        webAppBootstrapSecret: TEST_SECRET,
        sessions,
        pool,
        logger,
        setupRequiredAtBoot,
      });
      await app.ready();
      return app;
    };

    appSetupMode = await buildApp(true);
    appNormalMode = await buildApp(false);
  });

  afterAll(async () => {
    await appSetupMode.close();
    await appNormalMode.close();
    await pool.end();
  });

  // Clean up only test-prefixed rows. We never blind-delete by system_role='principal'
  // because that would destroy a real operator's principal contact when these tests
  // are run against a working dev database. The partial unique index on
  // system_role='principal' means tests that try to create a new principal MUST run
  // against a database where no prior principal exists — typically a fresh CI DB.
  beforeEach(async () => {
    await pool.query(
      `DELETE FROM contact_channel_identities WHERE contact_id IN
         (SELECT id FROM contacts WHERE display_name LIKE $1)`,
      [`${TEST_LABEL_PREFIX}%`],
    );
    await pool.query(`DELETE FROM contacts WHERE display_name LIKE $1`, [`${TEST_LABEL_PREFIX}%`]);
    await pool.query(
      `DELETE FROM kg_nodes WHERE source = 'bootstrap' AND label LIKE $1`,
      [`${TEST_LABEL_PREFIX}%`],
    );
  });

  describe('POST /api/setup/principal', () => {
    it('creates a principal contact and returns its IDs', async () => {
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Alice` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        contactId: string;
        kgNodeId: string;
        alreadyExisted: boolean;
      };
      expect(body.contactId).toBeTruthy();
      expect(body.kgNodeId).toBeTruthy();
      expect(body.alreadyExisted).toBe(false);

      // Verify the contact landed with the expected fields
      const row = await pool.query<{ system_role: string; display_name: string }>(
        `SELECT system_role, display_name FROM contacts WHERE id = $1`,
        [body.contactId],
      );
      expect(row.rows[0]!.system_role).toBe('principal');
      expect(row.rows[0]!.display_name).toBe(`${TEST_LABEL_PREFIX} Alice`);
    });

    it('is idempotent — second call returns the existing principal with alreadyExisted=true', async () => {
      const first = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Beth` },
      });
      const second = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Beth` },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const firstBody = JSON.parse(first.body);
      const secondBody = JSON.parse(second.body);
      expect(secondBody.alreadyExisted).toBe(true);
      expect(secondBody.contactId).toBe(firstBody.contactId);
    });

    it('returns 400 when the name is missing', async () => {
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when the name is empty or whitespace', async () => {
      const empty = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: '' },
      });
      expect(empty.statusCode).toBe(400);

      const whitespace = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: '   ' },
      });
      expect(whitespace.statusCode).toBe(400);
    });

    it('returns 400 when the name exceeds the length limit', async () => {
      const tooLong = 'X'.repeat(201);
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: tooLong },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} NoAuth` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/setup/status', () => {
    it('reports principalExists=false on a fresh DB (no principal, no identity)', async () => {
      const res = await appSetupMode.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.principalExists).toBe(false);
      // identityConfigured depends on whether anything else in this DB ever wrote
      // a wizard/api identity version — we only assert the field exists and is boolean.
      expect(typeof body.identityConfigured).toBe('boolean');
      // externalAdaptersPending requires both principal AND identityConfigured AND setupRequiredAtBoot.
      // Without a principal, it must be false regardless of the boot flag.
      expect(body.externalAdaptersPending).toBe(false);
    });

    it('reports principalExists=true after creating one', async () => {
      await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Carol` },
      });

      const res = await appSetupMode.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.principalExists).toBe(true);
    });

    it('externalAdaptersPending stays false in normal-mode boot even after setup completes', async () => {
      // Seed a principal so principalExists=true.
      await appSetupMode.inject({
        method: 'POST',
        url: '/api/setup/principal',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { name: `${TEST_LABEL_PREFIX} Dani` },
      });

      const res = await appNormalMode.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: AUTH_HEADER,
      });
      const body = JSON.parse(res.body);
      // setupRequiredAtBoot=false → externalAdaptersPending is always false,
      // since the adapters were already started at boot.
      expect(body.externalAdaptersPending).toBe(false);
    });

    it('returns 401 without auth', async () => {
      const res = await appSetupMode.inject({
        method: 'GET',
        url: '/api/setup/status',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
