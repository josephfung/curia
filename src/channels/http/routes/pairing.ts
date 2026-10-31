// pairing.ts — desktop mint and phone redeem (#2341, ADR-055).
//
// GET  /api/pairing/origin   — which origin the QR should use, and the warning.
// POST /api/pairing/codes    — mint a code. Authenticated.
// POST /api/pairing/redeem   — the code is the credential. Sets the session cookie.
//
// Redeem is rate-limited harder than other console routes: the short code is
// typed, so guessing has to be slow.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventBus } from '../../../bus/bus.js';
import { createOperatorSession } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import {
  deleteSession,
  deviceNameFromUserAgent,
  evictTokenHashes,
  issueSession,
  readUserAgent,
  sessionCookieOptions,
} from '../console-sessions.js';
import {
  choosePairOrigin,
  consumePairingCode,
  installabilityWarning,
  mintPairingCode,
  normalizeShortCode,
  releasePairingCode,
  type PairingCredential,
  type PairingQueryable,
} from '../pairing.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface PairingRouteOptions {
  pool: PairingQueryable;
  sessions: SessionStore;
  webAppBootstrapSecret: string;
  bus: EventBus;
  logger: Logger;
  secureCookies: boolean;
  appOrigin: string | undefined;
}

const READ_RATE = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
const MINT_RATE = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } };
const REDEEM_RATE = { config: { rateLimit: { max: 8, timeWindow: '10 minutes' } } };

export async function pairingRoutes(
  app: FastifyInstance,
  options: PairingRouteOptions,
): Promise<void> {
  const { pool, sessions, webAppBootstrapSecret, bus, logger, secureCookies, appOrigin } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  app.get('/api/pairing/origin', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const query = request.query as { desktopOrigin?: unknown };
    const desktopOrigin = typeof query.desktopOrigin === 'string' ? query.desktopOrigin : null;
    return reply.send(choosePairOrigin({ desktopOrigin, appOrigin }));
  });

  app.post('/api/pairing/codes', MINT_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = request.body as { origin?: unknown };
    const choice = choosePairOrigin({
      requested: typeof body?.origin === 'string' ? body.origin : null,
      appOrigin,
    });
    if (!choice.origin) {
      return reply.status(400).send({ error: 'Provide the https address your phone should open.' });
    }
    try {
      const minted = await mintPairingCode(pool, choice.origin);
      logger.info({ pairingCodeId: minted.id }, 'pairing code minted');
      return reply.status(201).send({
        pairUrl: minted.pairUrl,
        shortCode: minted.shortCode,
        expiresAt: minted.expiresAt,
        warning: minted.warning,
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/pairing/codes failed');
      return reply.status(503).send({ error: 'Could not create a pairing code. Please try again.' });
    }
  });

  app.post('/api/pairing/redeem', REDEEM_RATE, async (request, reply) => {
    const credential = readCredential(request.body);
    if (!credential) {
      return reply.status(400).send({ error: 'Provide the pairing code from the QR link or the short code.' });
    }
    let consumed: { id: string; origin: string } | null;
    try {
      consumed = await consumePairingCode(pool, credential);
    } catch (err) {
      logger.error({ err }, 'POST /api/pairing/redeem failed to read the code');
      return reply.status(503).send({ error: 'Pairing is temporarily unavailable. Please try again.' });
    }
    if (!consumed) {
      return reply.status(401).send({ error: 'That code is invalid or has expired.' });
    }

    const name = deviceNameFromUserAgent(readUserAgent(request));
    let issued: Awaited<ReturnType<typeof issueSession>>;
    try {
      issued = await issueSession(pool, sessions, {
        kind: 'paired_device',
        name,
        userAgent: readUserAgent(request),
      });
    } catch (err) {
      logger.error({ err, pairingCodeId: consumed.id }, 'POST /api/pairing/redeem failed to create the session');
      await releaseQuietly(pool, logger, consumed.id, credential.kind);
      return reply.status(503).send({ error: 'Pairing is temporarily unavailable. Please try again.' });
    }

    try {
      await bus.publish('system', createOperatorSession({
        action: 'pair',
        stage: 'completed',
        initiatedBy: 'session',
        actorSessionId: issued.id,
        sessionId: issued.id,
        kind: 'paired_device',
        name,
      }));
    } catch (err) {
      logger.error({ err, sessionId: issued.id }, 'Failed to record pairing audit — session removed');
      await deleteQuietly(pool, sessions, logger, issued.id, issued.tokenHash);
      await releaseQuietly(pool, logger, consumed.id, credential.kind);
      return reply.status(500).send({ error: 'Failed to record the pairing. The phone was not signed in.' });
    }

    reply.setCookie('curia_session', issued.token, sessionCookieOptions(secureCookies));
    return reply.send({
      ok: true,
      warning: installabilityWarning(consumed.origin),
    });
  });
}

function readCredential(body: unknown): PairingCredential | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as { token?: unknown; shortCode?: unknown };
  const hasToken = typeof record.token === 'string' && record.token.length > 0;
  const hasShort = typeof record.shortCode === 'string' && record.shortCode.length > 0;
  if (hasToken === hasShort) return null;
  if (hasToken) {
    const token = record.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
    return { kind: 'token', token };
  }
  const code = normalizeShortCode(record.shortCode);
  if (!code) return null;
  return { kind: 'short', code };
}

async function releaseQuietly(
  pool: PairingQueryable,
  logger: Logger,
  id: string,
  kind: PairingCredential['kind'],
): Promise<void> {
  try {
    await releasePairingCode(pool, id, kind);
  } catch (err) {
    logger.error({ err, pairingCodeId: id }, 'failed to release a pairing code after an error');
  }
}

async function deleteQuietly(
  pool: PairingQueryable,
  sessions: SessionStore,
  logger: Logger,
  id: string,
  tokenHash: string,
): Promise<void> {
  try {
    await deleteSession(pool, id);
    evictTokenHashes(sessions, [tokenHash]);
  } catch (err) {
    logger.error({ err, sessionId: id }, 'failed to remove a session after a pairing audit error');
  }
}
