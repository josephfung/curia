// Integration test — GET /api/tasks returns every open task; its 500-row cap applies
// to closed tasks only (#2350).
//
// The home's Open tasks tile links to the Tasks page filtered to open principal tasks.
// If the cap counted open tasks, newer closed tasks or a backlog of more than 500 open
// ones would push an open task out, and the page would show fewer than the tile counts.
//
// Runs inside one transaction that is rolled back, so nothing is left behind. The
// route reads through the same client, so it sees the uncommitted rows.
// Skips gracefully when DATABASE_URL is not set.

import Fastify from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskRoutes } from '../../src/channels/http/routes/tasks.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;
const SECRET = 'tasks-list-secret';

describeIf('GET /api/tasks open-first cap (#2350)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('returns old tasks in every open status even when 500 newer closed tasks fill the cap', async () => {
    const client = await pool.connect();
    const app = Fastify();
    try {
      await client.query('BEGIN');
      // One old task per open status, written as literals: dropping any status from
      // the route's open list then fails this test.
      const openIds: string[] = [];
      for (const status of ['open', 'in_progress', 'blocked', 'waiting']) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at)
           VALUES ('coordinator', $1, 'seeded', $2, '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}',
                   now() + interval '1 day')
           RETURNING id`,
          [`itest-2350 old ${status}`, status],
        );
        openIds.push(rows[0]!.id);
      }
      // 500 closed tasks, all touched after the open ones.
      await client.query(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at)
         SELECT 'coordinator', 'itest-2350 done ' || n, 'seeded', 'done', '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}',
                now() + interval '2 days' + n * interval '1 second'
         FROM generate_series(1, 500) AS n`,
      );

      await app.register(taskRoutes, {
        pool: { query: client.query.bind(client) } as unknown as pg.Pool,
        logger: createSilentLogger(),
        webAppBootstrapSecret: SECRET,
        contactService: {} as ContactService,
        sessions: new Map(),
      });
      const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: { 'x-web-bootstrap-secret': SECRET } });

      expect(res.statusCode).toBe(200);
      const tasks = (res.json() as { tasks: Array<{ id: string; status: string }> }).tasks;
      // The closed rows are capped; the shared test database may hold other open rows.
      expect(tasks.filter((task) => task.status === 'done')).toHaveLength(500);
      const returned = tasks.map((task) => task.id);
      for (const id of openIds) expect(returned).toContain(id);
    } finally {
      await app.close();
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('returns every open task when there are more than 500 of them', async () => {
    const client = await pool.connect();
    const app = Fastify();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at)
         SELECT 'coordinator', 'itest-2350 backlog ' || n, 'seeded', 'open', '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}',
                now() + n * interval '1 second'
         FROM generate_series(1, 501) AS n
         RETURNING id`,
      );

      await app.register(taskRoutes, {
        pool: { query: client.query.bind(client) } as unknown as pg.Pool,
        logger: createSilentLogger(),
        webAppBootstrapSecret: SECRET,
        contactService: {} as ContactService,
        sessions: new Map(),
      });
      const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: { 'x-web-bootstrap-secret': SECRET } });

      expect(res.statusCode).toBe(200);
      const returned = new Set((res.json() as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id));
      expect(rows.filter((row) => !returned.has(row.id))).toEqual([]);
    } finally {
      await app.close();
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
