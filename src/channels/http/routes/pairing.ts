// pairing.ts — desktop mint and phone redeem (#2341, ADR-055).
//
// GET  /api/pairing/origin      — which origin the QR should use, and the warning.
// POST /api/pairing/codes       — mint a code. Authenticated.
// GET  /api/pairing/codes/:id   — which credentials have been redeemed.
// POST /api/pairing/redeem      — the code is the credential. Sets the session cookie.
// GET  /api/pairing/invitation  — the current invitation link's state (#2412).
// POST /api/pairing/invitation  — mint an invitation link. Needs a console session.
// DELETE /api/pairing/invitation — stop the current invitation link.
//
// An invitation link has the QR link's shape, so redeem accepts its token in
// the same `token` field and under the same rate limit. A token that matches
// no pairing code is tried as an invitation.
//
// Redeem is rate-limited harder than other console routes: the short code is
// typed, so guessing has to be slow. The limit keys on request.ip, the same
// as /auth. trustProxy stays unset, so behind a reverse proxy the limit is
// shared by everyone using that proxy (ADR-055).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventBus } from '../../../bus/bus.js';
import { createOperatorSession } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import { isUuid } from '../../../util/uuid.js';
import { PAIRING_LIMIT_MESSAGE } from '../../../phone/phone-docs.js';
import {
  deleteSession,
  deviceNameFromUserAgent,
  evictTokenHashes,
  issueSession,
  readUserAgent,
  sessionCookieOptions,
} from '../console-sessions.js';
import {
  capPairingWindow,
  choosePairOrigin,
  consumePairingCode,
  installabilityWarning,
  mintPairingCode,
  normalizeShortCode,
  readPairingCodeStatus,
  releasePairingCode,
  type PairingCredential,
  type PairingQueryable,
} from '../pairing.js';
import {
  cancelInvitation,
  consumeInvitation,
  mintInvitation,
  readCurrentInvitation,
  recordPairedNotice,
  releaseInvitation,
} from '../pairing-invitations.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { actorFromRequest } from './sessions.js';

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

/** What redeem consumed, so a failure can put back the right credential. */
type Redemption =
  | { source: 'code'; id: string; origin: string; kind: PairingCredential['kind']; otherAlreadyRedeemed: boolean }
  | { source: 'invitation'; id: string; origin: string };

export async function pairingRoutes(
  app: FastifyInstance,
  options: PairingRouteOptions,
): Promise<void> {
  const { pool, sessions, webAppBootstrapSecret, bus, logger, secureCookies, appOrigin } = options;

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    if (statusCode === 429) {
      return reply.status(429).send({ error: PAIRING_LIMIT_MESSAGE });
    }
    return reply.send(error);
  });

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  app.get('/api/pairing/origin', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const query = request.query as { desktopOrigin?: unknown; requested?: unknown };
    const desktopOrigin = typeof query.desktopOrigin === 'string' ? query.desktopOrigin : null;
    const requested = typeof query.requested === 'string' ? query.requested : null;
    // JSON from choosePairOrigin (origin, warning, askForOrigin). Not HTML.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(choosePairOrigin({ requested, desktopOrigin, appOrigin }));
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
        id: minted.id,
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

  app.get<{ Params: { id: string } }>('/api/pairing/codes/:id', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const id = request.params.id;
    if (!isUuid(id)) return reply.status(404).send({ error: 'That pairing code was not found.' });
    try {
      const status = await readPairingCodeStatus(pool, id);
      if (!status) return reply.status(404).send({ error: 'That pairing code was not found.' });
      // JSON status for the desktop poll. The device name is our own label.
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      return reply.send(status);
    } catch (err) {
      logger.error({ err, pairingCodeId: id }, 'GET /api/pairing/codes/:id failed');
      return reply.status(503).send({ error: 'Could not read the pairing code. Please try again.' });
    }
  });

  app.get('/api/pairing/invitation', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const current = await readCurrentInvitation(pool);
      // JSON state for the console. The device name is our own label.
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      return reply.send({ invitation: current });
    } catch (err) {
      logger.error({ err }, 'GET /api/pairing/invitation failed');
      return reply.status(503).send({ error: 'Could not read the invitation link. Please try again.' });
    }
  });

  app.post('/api/pairing/invitation', MINT_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    // A 48-hour credential is minted only from a signed-in console session,
    // never from the access-key header alone, so the audit names a session.
    const actor = actorFromRequest(request, sessions);
    if (actor.initiatedBy !== 'session' || !actor.actorSessionId) {
      return reply.status(401).send({ error: 'Sign in to the console to create an invitation link.' });
    }
    const body = request.body as { origin?: unknown };
    const choice = choosePairOrigin({
      requested: typeof body?.origin === 'string' ? body.origin : null,
      appOrigin,
    });
    if (!choice.origin) {
      return reply.status(400).send({ error: "Provide the https address the principal's phone should open." });
    }
    let minted: Awaited<ReturnType<typeof mintInvitation>>;
    try {
      minted = await mintInvitation(pool, choice.origin);
    } catch (err) {
      logger.error({ err }, 'POST /api/pairing/invitation failed');
      return reply.status(503).send({ error: 'Could not create an invitation link. Please try again.' });
    }
    try {
      await bus.publish('system', createOperatorSession({
        action: 'invite',
        stage: 'completed',
        initiatedBy: 'session',
        actorSessionId: actor.actorSessionId,
      }));
    } catch (err) {
      logger.error({ err, pairingInvitationId: minted.id }, 'Failed to record invitation audit — link stopped');
      try {
        await cancelInvitation(pool);
      } catch (cancelErr) {
        logger.error({ err: cancelErr, pairingInvitationId: minted.id }, 'failed to stop an unaudited invitation link');
      }
      return reply.status(500).send({ error: 'Failed to record the invitation. The link was not created.' });
    }
    logger.info({ pairingInvitationId: minted.id }, 'pairing invitation minted');
    return reply.status(201).send(minted);
  });

  app.delete('/api/pairing/invitation', MINT_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    let stopped: boolean;
    try {
      stopped = await cancelInvitation(pool);
    } catch (err) {
      logger.error({ err }, 'DELETE /api/pairing/invitation failed');
      return reply.status(503).send({ error: 'Could not stop the invitation link. Please try again.' });
    }
    if (stopped) {
      try {
        await bus.publish('system', createOperatorSession({
          action: 'cancel_invite',
          stage: 'completed',
          ...actorFromRequest(request, sessions),
        }));
      } catch (err) {
        // The link is already dead, which is the safe outcome. Say so in the log.
        logger.error({ err }, 'Invitation link stopped but the audit could not be recorded');
      }
    }
    return reply.send({ stopped });
  });

  app.post('/api/pairing/redeem', REDEEM_RATE, async (request, reply) => {
    const credential = readCredential(request.body);
    if (!credential) {
      return reply.status(400).send({ error: 'Provide the pairing code from the QR link or the short code.' });
    }
    const name = deviceNameFromUserAgent(readUserAgent(request));
    let redeemed: Redemption | null;
    try {
      redeemed = await redeemCredential(pool, credential, name);
    } catch (err) {
      logger.error({ err }, 'POST /api/pairing/redeem failed to read the code');
      return reply.status(503).send({ error: 'Pairing is temporarily unavailable. Please try again.' });
    }
    if (!redeemed) {
      return reply.status(401).send({ error: 'That code is invalid or has expired.' });
    }
    const logRef = redeemed.source === 'invitation'
      ? { pairingInvitationId: redeemed.id }
      : { pairingCodeId: redeemed.id };
    if (redeemed.source === 'code' && redeemed.otherAlreadyRedeemed) {
      logger.warn({ ...logRef, kind: redeemed.kind }, 'second pairing credential redeemed');
    }

    let issued: Awaited<ReturnType<typeof issueSession>>;
    try {
      issued = await issueSession(pool, sessions, {
        kind: 'paired_device',
        name,
        userAgent: readUserAgent(request),
      });
    } catch (err) {
      logger.error({ err, ...logRef }, 'POST /api/pairing/redeem failed to create the session');
      await releaseQuietly(pool, logger, redeemed);
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
        ...(redeemed.source === 'code' && redeemed.otherAlreadyRedeemed ? { secondCredential: true } : {}),
        ...(redeemed.source === 'invitation' ? { invitation: true } : {}),
      }));
    } catch (err) {
      logger.error({ err, sessionId: issued.id }, 'Failed to record pairing audit — session removed');
      await deleteQuietly(pool, sessions, logger, issued.id, issued.tokenHash);
      await releaseQuietly(pool, logger, redeemed);
      return reply.status(500).send({ error: 'Failed to record the pairing. The phone was not signed in.' });
    }

    if (redeemed.source === 'code') {
      try {
        await capPairingWindow(pool, redeemed.id);
      } catch (err) {
        // The session and the audit already succeeded. Removing them here would
        // contradict the audit. The unused credential keeps the original window.
        logger.error({ err, ...logRef }, 'pairing window was not capped');
      }
    } else {
      try {
        await recordPairedNotice(pool, issued.id, name);
      } catch (err) {
        // The pairing is audited and the Devices list shows the session, so a
        // missing banner is not worth failing a sign-in that already happened.
        logger.error({ err, ...logRef }, 'invitation pairing notice was not recorded');
      }
      logger.info({ ...logRef, sessionId: issued.id }, 'pairing invitation redeemed');
    }

    reply.setCookie('curia_session', issued.token, sessionCookieOptions(secureCookies));
    return reply.send({
      ok: true,
      warning: installabilityWarning(redeemed.origin),
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

/** A token that matches no pairing code may be an invitation link. */
async function redeemCredential(
  pool: PairingQueryable,
  credential: PairingCredential,
  deviceName: string | null,
): Promise<Redemption | null> {
  const code = await consumePairingCode(pool, credential, deviceName);
  if (code) {
    return {
      source: 'code',
      id: code.id,
      origin: code.origin,
      kind: credential.kind,
      otherAlreadyRedeemed: code.otherAlreadyRedeemed,
    };
  }
  if (credential.kind !== 'token') return null;
  const invitation = await consumeInvitation(pool, credential.token, deviceName);
  if (!invitation) return null;
  return { source: 'invitation', id: invitation.id, origin: invitation.origin };
}

async function releaseQuietly(pool: PairingQueryable, logger: Logger, redeemed: Redemption): Promise<void> {
  try {
    if (redeemed.source === 'code') await releasePairingCode(pool, redeemed.id, redeemed.kind);
    else await releaseInvitation(pool, redeemed.id);
  } catch (err) {
    logger.error({ err, source: redeemed.source, id: redeemed.id }, 'failed to release a pairing credential after an error');
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
