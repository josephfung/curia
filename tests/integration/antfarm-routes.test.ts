import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import pino from 'pino';
import { antfarmRoutes } from '../../src/channels/http/routes/antfarm.js';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { EventRouter } from '../../src/channels/http/event-router.js';

const logger = pino({ level: 'silent' });
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('Ant Farm REST routes', () => {
  let app: ReturnType<typeof Fastify>;
  let pool: pg.Pool;
  let repo: AuditLogRepo;
  const sessions = new Map<string, number>();
  const TEST_SECRET = 'test-antfarm-secret';
  const AUTH_HEADER = { 'x-web-bootstrap-secret': TEST_SECRET };
  const sourceLayer = 'test-antfarm-routes';

  beforeAll(async () => {
    app = Fastify();
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    repo = new AuditLogRepo(pool, logger);
    const eventRouter = new EventRouter(logger);

    await pool.query('SELECT 1 FROM audit_log LIMIT 0');

    await app.register(antfarmRoutes, {
      auditLogRepo: repo,
      eventRouter,
      webAppBootstrapSecret: TEST_SECRET,
      sessions,
      logger,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('rejects unauthenticated timeline requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/antfarm/timeline',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns interpreted directives for a seeded window', async () => {
    const from = '2026-07-02T20:00:00.000Z';
    const to = '2026-07-02T21:00:00.000Z';
    await pool.query(
      `INSERT INTO audit_log (timestamp, event_type, source_layer, source_id, payload, conversation_id)
       VALUES ($1, 'task.created', $2, 'coordinator', $3::jsonb, 'conv-antfarm')`,
      [
        new Date('2026-07-02T20:30:00.000Z'),
        sourceLayer,
        JSON.stringify({ taskId: 'task-af2', title: 'Demo task' }),
      ],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/antfarm/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&conversationId=conv-antfarm`,
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { directives: Array<{ kind: string; taskId?: string }> };
    expect(body.directives.some((d) => d.kind === 'task.appear' && d.taskId === 'task-af2')).toBe(true);
  });

  it('rejects unauthenticated stream requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/antfarm/stream',
    });
    expect(res.statusCode).toBe(401);
  });
});
