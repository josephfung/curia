// sessions.ts — logout and the Devices page API (#2341, ADR-055).
//
// POST /auth/logout ends the caller's session.
// GET    /api/sessions lists live sessions.
// PATCH  /api/sessions/:id renames one.
// DELETE /api/sessions/:id revokes one, and its push subscriptions when those exist.
// POST   /api/sessions/revoke-others ends every session except the caller's.
//
// Each destructive action is audited as operator.session before the rows go,
// so a failed audit leaves the session in place.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventBus } from '../../../bus/bus.js';
import { createOperatorSession } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import {
  clearSessionCookie,
  deleteSession,
  deleteSessionsByIds,
  evictTokenHashes,
  findSessionById,
  findSessionByTokenHash,
  listDeviceSessions,
  normalizeDeviceName,
  renameSession,
  selectOtherSessions,
  type SessionQueryable,
} from '../console-sessions.js';
import {
  assertSecret,
  hashToken,
  readSessionCookie,
  type SessionStore,
} from '../session-auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionRouteOptions {
  pool: SessionQueryable;
  sessions: SessionStore;
  webAppBootstrapSecret: string;
  bus: EventBus;
  logger: Logger;
}

export async function sessionRoutes(
  app: FastifyInstance,
  options: SessionRouteOptions,
): Promise<void> {
  const { pool, sessions, webAppBootstrapSecret, bus, logger } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  const READ_RATE = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const WRITE_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/auth/logout', WRITE_RATE, async (request, reply) => {
    const token = readSessionCookie(request);
    if (!token) {
      return reply.status(401).send({ error: 'No session cookie.' });
    }
    const tokenHash = hashToken(token);
    let current: Awaited<ReturnType<typeof findSessionByTokenHash>>;
    try {
      current = await findSessionByTokenHash(pool, tokenHash);
    } catch (err) {
      logger.error({ err }, 'POST /auth/logout: failed to read the session');
      return reply.status(503).send({ error: 'Logout is temporarily unavailable. Please try again.' });
    }
    if (!current) {
      evictTokenHashes(sessions, [tokenHash]);
      clearSessionCookie(reply);
      return reply.status(401).send({ error: 'Session already ended.' });
    }

    const audited = await publishSession(bus, logger, reply, {
      action: 'logout',
      sessionId: current.id,
      kind: current.kind,
      name: current.name ?? undefined,
    });
    if (!audited) return;

    try {
      await deleteSession(pool, current.id);
    } catch (err) {
      logger.error({ err, sessionId: current.id }, 'POST /auth/logout: failed to delete the session');
      return reply.status(503).send({ error: 'Logout is temporarily unavailable. Please try again.' });
    }
    evictTokenHashes(sessions, [tokenHash]);
    clearSessionCookie(reply);
    return reply.status(200).send({ ok: true });
  });

  app.get('/api/sessions', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const token = readSessionCookie(request);
    const tokenHash = token ? hashToken(token) : null;
    let currentId: string | null = null;
    if (tokenHash) {
      const entry = sessions.get(tokenHash);
      currentId = typeof entry === 'object' ? (entry.id ?? null) : null;
      if (!currentId) {
        try {
          currentId = (await findSessionByTokenHash(pool, tokenHash))?.id ?? null;
        } catch (err) {
          logger.error({ err }, 'GET /api/sessions: failed to identify the current session');
          return reply.status(503).send({ error: 'Could not load devices. Please try again.' });
        }
      }
    }
    let devices: Awaited<ReturnType<typeof listDeviceSessions>>;
    try {
      devices = await listDeviceSessions(pool);
    } catch (err) {
      logger.error({ err }, 'GET /api/sessions: failed to list sessions');
      return reply.status(503).send({ error: 'Could not load devices. Please try again.' });
    }
    return reply.send({
      sessions: devices.map((device) => ({
        ...device,
        current: device.id === currentId,
      })),
    });
  });

  app.patch<{ Params: { id: string } }>('/api/sessions/:id', WRITE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const id = request.params.id;
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Unknown device.' });
    }
    const body = request.body as { name?: unknown };
    const name = normalizeDeviceName(body?.name);
    if (!name) {
      return reply.status(400).send({ error: 'Name must be 1–80 characters.' });
    }
    let renamed: boolean;
    try {
      renamed = await renameSession(pool, id, name);
    } catch (err) {
      logger.error({ err, sessionId: id }, 'PATCH /api/sessions/:id: rename failed');
      return reply.status(503).send({ error: 'Could not rename the device. Please try again.' });
    }
    if (!renamed) return reply.status(404).send({ error: 'Device not found.' });
    return reply.send({ id, name });
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', WRITE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const id = request.params.id;
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Unknown device.' });
    }

    let target: Awaited<ReturnType<typeof findSessionById>>;
    try {
      target = await findSessionById(pool, id);
    } catch (err) {
      logger.error({ err, sessionId: id }, 'DELETE /api/sessions/:id: lookup failed');
      return reply.status(503).send({ error: 'Could not revoke the device. Please try again.' });
    }
    if (!target) return reply.status(404).send({ error: 'Device not found.' });

    const token = readSessionCookie(request);
    const tokenHash = token ? hashToken(token) : null;
    const audited = await publishSession(bus, logger, reply, {
      action: 'revoke',
      sessionId: target.id,
      kind: target.kind,
      name: target.name ?? undefined,
    });
    if (!audited) return;

    try {
      await deleteSession(pool, id);
    } catch (err) {
      logger.error({ err, sessionId: id }, 'DELETE /api/sessions/:id: revoke failed');
      return reply.status(503).send({ error: 'Could not revoke the device. Please try again.' });
    }
    evictTokenHashes(sessions, [target.tokenHash]);
    const current = target.tokenHash === tokenHash;
    if (current) clearSessionCookie(reply);
    return reply.send({ revoked: true, current });
  });

  app.post('/api/sessions/revoke-others', WRITE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const token = readSessionCookie(request);
    const spare = token ? hashToken(token) : null;
    let others: Awaited<ReturnType<typeof selectOtherSessions>>;
    try {
      others = await selectOtherSessions(pool, spare);
    } catch (err) {
      logger.error({ err }, 'POST /api/sessions/revoke-others: failed to list sessions');
      return reply.status(503).send({ error: 'Could not sign out other devices. Please try again.' });
    }

    const audited = await publishSession(bus, logger, reply, {
      action: 'sign_out_others',
      revokedCount: others.length,
    });
    if (!audited) return;

    try {
      await deleteSessionsByIds(pool, others.map((row) => row.id));
    } catch (err) {
      logger.error({ err }, 'POST /api/sessions/revoke-others: delete failed');
      return reply.status(503).send({ error: 'Could not sign out other devices. Please try again.' });
    }
    evictTokenHashes(sessions, others.map((row) => row.tokenHash));
    return reply.send({ revoked: others.length });
  });
}

async function publishSession(
  bus: EventBus,
  logger: Logger,
  reply: FastifyReply,
  payload: {
    action: 'logout' | 'revoke' | 'sign_out_others' | 'pair';
    sessionId?: string;
    kind?: 'browser' | 'paired_device';
    name?: string;
    revokedCount?: number;
  },
): Promise<boolean> {
  try {
    await bus.publish('system', createOperatorSession(payload));
    return true;
  } catch (err) {
    logger.error({ err, action: payload.action }, 'Failed to record session audit event — session left in place');
    reply.status(500).send({ error: 'Failed to record the change. The session was left in place.' });
    return false;
  }
}
