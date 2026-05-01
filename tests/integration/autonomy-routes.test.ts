import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import pg from 'pg';
import pino from 'pino';
import { autonomyRoutes } from '../../src/channels/http/routes/autonomy.js';
import { AutonomyService } from '../../src/autonomy/autonomy-service.js';

const logger = pino({ level: 'silent' });

describe('Autonomy REST routes', () => {
  let app: ReturnType<typeof Fastify>;
  let pool: pg.Pool;
  let autonomyService: AutonomyService;

  // Fake session store — pre-seed a valid session token for tests.
  const sessions: Map<string, number> = new Map();
  const TEST_SECRET = 'test-bootstrap-secret';
  const AUTH_HEADER = { 'x-web-bootstrap-secret': TEST_SECRET };

  beforeAll(async () => {
    if (!process.env['DATABASE_URL']) {
      throw new Error('DATABASE_URL must be set to run autonomy route integration tests');
    }
    app = Fastify();
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    autonomyService = new AutonomyService(pool, logger);

    // Ensure tables exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomy_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        score INTEGER NOT NULL DEFAULT 75,
        band TEXT NOT NULL DEFAULT 'approval-required',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by TEXT NOT NULL DEFAULT 'system'
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autonomy_history (
        id SERIAL PRIMARY KEY,
        score INTEGER NOT NULL,
        previous_score INTEGER,
        band TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        reason TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Reset state
    await pool.query('DELETE FROM autonomy_history');
    await pool.query('DELETE FROM autonomy_config');
    await pool.query(
      `INSERT INTO autonomy_config (id, score, band, updated_by) VALUES (1, 75, 'approval-required', 'test')`
    );

    await app.register(cookie);
    await app.register(autonomyRoutes, {
      autonomyService,
      webAppBootstrapSecret: TEST_SECRET,
      sessions,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('GET /api/autonomy', () => {
    it('returns current autonomy config', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.autonomy.score).toBe(75);
      expect(body.autonomy.band).toBe('approval-required');
      expect(body.autonomy.bandDescription).toBeTruthy();
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /api/autonomy', () => {
    beforeAll(async () => {
      // Reset score to 75 so PUT tests start from a known state
      await pool.query(
        `UPDATE autonomy_config SET score = 75, band = 'approval-required', updated_by = 'test' WHERE id = 1`
      );
      await pool.query('DELETE FROM autonomy_history');
    });

    it('sets score and returns new config', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/autonomy',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { score: 85, reason: 'Testing increase' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.autonomy.score).toBe(85);
      expect(body.autonomy.band).toBe('spot-check');
      expect(body.previousScore).toBe(75);
      expect(body.updated).toBe(true);
    });

    it('returns 400 for invalid score', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/autonomy',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { score: 150 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for missing score', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/autonomy',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { reason: 'no score provided' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/autonomy',
        headers: { 'content-type': 'application/json' },
        payload: { score: 85 },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/autonomy/history', () => {
    beforeAll(async () => {
      // Ensure at least one history entry exists by making a known PUT
      await app.inject({
        method: 'PUT',
        url: '/api/autonomy',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { score: 85, reason: 'Testing increase' },
      });
    });

    it('returns paginated history with total', async () => {
      // At least one entry was inserted by the beforeAll above
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy/history?limit=5&offset=0',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.history.length).toBeGreaterThanOrEqual(1);
      expect(typeof body.total).toBe('number');
      expect(body.history[0].changedBy).toBe('web-ui');
      expect(body.history[0].reason).toBe('Testing increase');
    });

    it('respects offset parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy/history?limit=5&offset=100',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.history.length).toBe(0);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/autonomy/history',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
