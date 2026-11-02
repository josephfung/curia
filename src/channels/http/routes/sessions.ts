// sessions.ts — logout and the Devices page API (#2341, ADR-055).
//
// POST /auth/logout ends the caller's session.
// GET    /api/sessions lists live sessions.
// PATCH  /api/sessions/:id renames one.
// DELETE /api/sessions/:id revokes one. Push subscriptions, once they exist,
//           go with the row through ON DELETE CASCADE (web-push migration).
// POST   /api/sessions/revoke-others ends every other live session when the
//           caller has a cookie. With the bootstrap-secret header and no
//           cookie it ends every live session, which is how an access-key
//           rotation cuts off old browsers. Spec 12 says the same.
//
// Each destructive action publishes operator.session stage=requested first.
// A failed audit leaves the session in place. stage=completed follows a
// successful delete. stage=failed is published when the delete throws, so the
// log does not claim a session ended while it is still alive.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventBus } from '../../../bus/bus.js';
import { createOperatorSession, type OperatorSessionEvent } from '../../../bus/events.js';
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
  CONSOLE_RATE,
  type SessionStore,
} from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';

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

  const READ_RATE = CONSOLE_RATE;
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

    const audit = {
      action: 'logout' as const,
      initiatedBy: 'session' as const,
      actorSessionId: current.id,
      sessionId: current.id,
      kind: current.kind,
      name: current.name ?? undefined,
    };
    if (!await publishSession(bus, logger, reply, { ...audit, stage: 'requested' })) return;

    try {
      await deleteSession(pool, current.id);
    } catch (err) {
      logger.error({ err, sessionId: current.id }, 'POST /auth/logout: failed to delete the session');
      await publishFailure(bus, logger, audit);
      return reply.status(503).send({ error: 'Logout is temporarily unavailable. Please try again.' });
    }
    await publishCompletion(bus, logger, audit);
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
      currentId = entry?.id ?? null;
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
    if (!isUuid(id)) {
      return reply.status(400).send({ error: 'Unknown device.' });
    }
    const body = request.body as { name?: unknown };
    const name = normalizeDeviceName(body?.name);
    if (!name) {
      return reply.status(400).send({ error: 'Name must be 1–80 characters and cannot include hidden characters.' });
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
    if (!isUuid(id)) {
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
    const actor = actorFromRequest(request, sessions);
    const audit = {
      action: 'revoke' as const,
      ...actor,
      sessionId: target.id,
      kind: target.kind,
      name: target.name ?? undefined,
    };
    if (!await publishSession(bus, logger, reply, { ...audit, stage: 'requested' })) return;

    try {
      await deleteSession(pool, id);
    } catch (err) {
      logger.error({ err, sessionId: id }, 'DELETE /api/sessions/:id: revoke failed');
      await publishFailure(bus, logger, audit);
      return reply.status(503).send({ error: 'Could not revoke the device. Please try again.' });
    }
    await publishCompletion(bus, logger, audit);
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

    const actor = actorFromRequest(request, sessions);
    const audit = {
      action: 'sign_out_others' as const,
      ...actor,
      revokedCount: others.length,
      revokedSessionIds: others.map((row) => row.id),
    };
    if (!await publishSession(bus, logger, reply, { ...audit, stage: 'requested' })) return;

    try {
      await deleteSessionsByIds(pool, others.map((row) => row.id));
    } catch (err) {
      logger.error({ err }, 'POST /api/sessions/revoke-others: delete failed');
      await publishFailure(bus, logger, audit);
      return reply.status(503).send({ error: 'Could not sign out other devices. Please try again.' });
    }
    await publishCompletion(bus, logger, audit);
    evictTokenHashes(sessions, others.map((row) => row.tokenHash));
    return reply.send({ revoked: others.length });
  });
}

type SessionAudit = Omit<OperatorSessionEvent['payload'], 'stage'>;

export function actorFromRequest(
  request: FastifyRequest,
  sessions: SessionStore,
): { initiatedBy: 'session' | 'bootstrap_secret'; actorSessionId?: string } {
  const token = readSessionCookie(request);
  if (!token) return { initiatedBy: 'bootstrap_secret' };
  const entry = sessions.get(hashToken(token));
  // An expired cookie still in the map did not authenticate this request.
  // The header did, so the actor is the access key.
  if (!entry || entry.expiresAt <= Date.now()) return { initiatedBy: 'bootstrap_secret' };
  return { initiatedBy: 'session', actorSessionId: entry.id };
}

async function publishSession(
  bus: EventBus,
  logger: Logger,
  reply: FastifyReply,
  payload: OperatorSessionEvent['payload'],
): Promise<boolean> {
  try {
    await bus.publish('system', createOperatorSession(payload));
    return true;
  } catch (err) {
    logger.error({ err, action: payload.action, stage: payload.stage }, 'Failed to record session audit event — session left in place');
    reply.status(500).send({ error: 'Failed to record the change. The session was left in place.' });
    return false;
  }
}

async function publishCompletion(bus: EventBus, logger: Logger, audit: SessionAudit): Promise<void> {
  try {
    await bus.publish('system', createOperatorSession({ ...audit, stage: 'completed' }));
  } catch (err) {
    logger.error({ err, action: audit.action }, 'Session ended but the completion audit could not be recorded');
  }
}

async function publishFailure(bus: EventBus, logger: Logger, audit: SessionAudit): Promise<void> {
  try {
    await bus.publish('system', createOperatorSession({ ...audit, stage: 'failed' }));
  } catch (err) {
    logger.error({ err, action: audit.action }, 'Session delete failed and the failure audit could not be recorded');
  }
}
