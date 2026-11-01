// push.ts — phone notification subscription and the hide-previews switch (#2341).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../logger.js';
import { findSessionByTokenHash, type SessionQueryable } from '../console-sessions.js';
import type { WebPushService } from '../../web/push-service.js';
import { isDeliverablePushEndpoint, pushKeyLengths } from '../../web/push-endpoint.js';
import { assertSecret, hashToken, readSessionCookie, type SessionStore } from '../session-auth.js';

export interface PushRouteOptions {
  pool: SessionQueryable;
  sessions: SessionStore;
  webAppBootstrapSecret: string;
  webPush: WebPushService;
  logger: Logger;
}

const READ_RATE = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
const WRITE_RATE = { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } };

export async function pushRoutes(app: FastifyInstance, options: PushRouteOptions): Promise<void> {
  const { pool, sessions, webAppBootstrapSecret, webPush, logger } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  app.get('/api/push/config', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const settings = await pool.query(`SELECT hide_previews FROM push_settings WHERE id = 1`);
      const notices = await pool.query(
        `SELECT id, kind, detail, created_at FROM push_notices WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT 5`,
      );
      const sessionId = await currentSessionId(request, pool);
      const subscribed = sessionId
        ? (await pool.query(`SELECT 1 FROM push_subscriptions WHERE session_id = $1 LIMIT 1`, [sessionId])).rows.length > 0
        : false;
      return reply.send({
        publicKey: webPush.publicKey,
        configured: webPush.publicKey !== null,
        subscribed,
        hidePreviews: settings.rows[0]?.['hide_previews'] === true,
        notices: notices.rows.map((row) => ({
          id: String(row['id']),
          kind: row['kind'] === 'setup' ? 'setup' : 'dead',
          detail: String(row['detail']),
          createdAt: row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']),
        })),
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/push/config failed');
      return reply.status(503).send({ error: 'Notifications are temporarily unavailable.' });
    }
  });

  app.put('/api/push/settings', WRITE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = request.body as { hidePreviews?: unknown };
    if (typeof body?.hidePreviews !== 'boolean') {
      return reply.status(400).send({ error: 'hidePreviews must be true or false.' });
    }
    try {
      await pool.query(`UPDATE push_settings SET hide_previews = $1 WHERE id = 1`, [body.hidePreviews]);
      return reply.send({ hidePreviews: body.hidePreviews });
    } catch (err) {
      logger.error({ err }, 'PUT /api/push/settings failed');
      return reply.status(503).send({ error: 'Could not save the notification setting.' });
    }
  });

  app.post('/api/push/subscriptions', WRITE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    if (!webPush.publicKey) {
      return reply.status(409).send({ error: 'This Curia is not on HTTPS, so the phone cannot receive notifications.' });
    }
    const sessionId = await currentSessionId(request, pool);
    if (!sessionId) return reply.status(401).send({ error: 'No session cookie.' });
    const parsed = readSubscription(request.body);
    if (!parsed) return reply.status(400).send({ error: 'A push subscription needs an https endpoint and its keys.' });
    try {
      await pool.query(
        `INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth_secret)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE
           SET session_id = EXCLUDED.session_id,
               p256dh = EXCLUDED.p256dh,
               auth_secret = EXCLUDED.auth_secret,
               consecutive_failures = 0,
               last_failure_at = NULL`,
        [sessionId, parsed.endpoint, parsed.p256dh, parsed.auth],
      );
      return reply.status(201).send({ ok: true });
    } catch (err) {
      logger.error({ err }, 'POST /api/push/subscriptions failed');
      return reply.status(503).send({ error: 'Could not save the notification subscription.' });
    }
  });

  app.delete('/api/push/subscriptions', WRITE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const sessionId = await currentSessionId(request, pool);
    if (!sessionId) return reply.status(401).send({ error: 'No session cookie.' });
    try {
      await pool.query(`DELETE FROM push_subscriptions WHERE session_id = $1`, [sessionId]);
      return reply.send({ ok: true });
    } catch (err) {
      logger.error({ err }, 'DELETE /api/push/subscriptions failed');
      return reply.status(503).send({ error: 'Could not remove the notification subscription.' });
    }
  });

  app.post('/api/push/notices/:id/dismiss', WRITE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const id = (request.params as { id?: string }).id ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'Unknown notice.' });
    try {
      await pool.query(`UPDATE push_notices SET dismissed_at = NOW() WHERE id = $1 AND dismissed_at IS NULL`, [id]);
      return reply.send({ ok: true });
    } catch (err) {
      logger.error({ err }, 'POST /api/push/notices/:id/dismiss failed');
      return reply.status(503).send({ error: 'Could not dismiss the notice.' });
    }
  });
}

async function currentSessionId(request: FastifyRequest, pool: SessionQueryable): Promise<string | null> {
  const token = readSessionCookie(request);
  if (!token) return null;
  const found = await findSessionByTokenHash(pool, hashToken(token));
  return found?.id ?? null;
}

function readSubscription(body: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const row = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof row.endpoint !== 'string' || !isDeliverablePushEndpoint(row.endpoint)) return null;
  const p256dh = row.keys?.p256dh;
  const auth = row.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (!pushKeyLengths(p256dh, auth)) return null;
  return { endpoint: row.endpoint, p256dh, auth };
}
