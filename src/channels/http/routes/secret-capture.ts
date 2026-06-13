// secret-capture.ts — public HTTP routes for the one-time secret-capture form (#971).
//
// UNAUTHENTICATED except for the token: the single-use, 30-minute token in the URL IS the
// capability. These routes are registered OUTSIDE the bearer-auth guard (see http-adapter's
// onRequest exemption list) and self-authorize purely by redeeming the token. There is no
// read path — the form can only WRITE a value into the vault, never reveal one.
//
//   GET  /api/secret-capture/:token  — form metadata { label, value_format } | 410 | 404
//   POST /api/secret-capture/:token  — submit { value } → write to vault | 410 | 404 | 400
//
// 410 Gone (not 404) for expired/consumed tokens deliberately does not distinguish "never
// existed" from "already used" beyond what the user needs: a 404 means the token was never
// valid, a 410 means it was valid but is now spent. Neither reveals whether the target vault
// key already exists.

import type { FastifyInstance } from 'fastify';
import type { CaptureMetadata, RedeemResult } from '../../../secrets/secret-capture-service.js';

/** The narrow service surface these routes need: read metadata, redeem a value. No mint. */
export interface SecretCapturePort {
  getMetadata(rawToken: string): Promise<CaptureMetadata>;
  redeem(rawToken: string, value: string): Promise<RedeemResult>;
}

export interface SecretCaptureRouteOptions {
  secretCaptureService: SecretCapturePort;
}

/** Generous ceiling for a captured value (API keys, passwords, small JSON credential sets).
 *  Matches the vault PUT route's cap so neither surface accepts an oversized blob. */
const MAX_CAPTURE_VALUE_LENGTH = 8192;

export async function secretCaptureRoutes(
  app: FastifyInstance,
  options: SecretCaptureRouteOptions,
): Promise<void> {
  const { secretCaptureService } = options;

  // Tight per-route rate limit — the token is unauthenticated, so cap brute-force/abuse
  // per IP the same way POST /auth does. No-op if @fastify/rate-limit isn't registered.
  const CAPTURE_RATE = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } };

  // -- GET metadata for the form --
  app.get('/api/secret-capture/:token', CAPTURE_RATE, async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const meta = await secretCaptureService.getMetadata(token);
      if (meta === 'not_found') {
        return reply.status(404).send({ error: 'This capture link is not valid.' });
      }
      if (meta === 'expired') {
        return reply.status(410).send({ error: 'This capture link has expired or already been used.' });
      }
      return reply.send({ label: meta.label, value_format: meta.valueFormat });
    } catch (err) {
      // Never log the token — only that the lookup failed.
      request.log.error({ err }, 'GET /api/secret-capture failed');
      return reply.status(500).send({ error: 'Failed to load the capture form. Check server logs.' });
    }
  });

  // -- POST the submitted value --
  app.post('/api/secret-capture/:token', CAPTURE_RATE, async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = request.body as { value?: unknown } | undefined;
    const value = body?.value;

    // Value must be a non-empty string within the size cap. Validated here so the service
    // only ever sees a sane value (and so an empty submission can't consume the token).
    if (typeof value !== 'string' || value.length === 0) {
      return reply.status(400).send({ error: 'Body must include a non-empty string "value".' });
    }
    if (value.length > MAX_CAPTURE_VALUE_LENGTH) {
      return reply.status(400).send({ error: `Value exceeds ${MAX_CAPTURE_VALUE_LENGTH} characters.` });
    }

    try {
      const result = await secretCaptureService.redeem(token, value);
      switch (result) {
        case 'ok':
          return reply.send({ ok: true });
        case 'not_found':
          return reply.status(404).send({ error: 'This capture link is not valid.' });
        case 'expired':
          return reply.status(410).send({ error: 'This capture link has expired or already been used.' });
        case 'invalid_json':
          return reply.status(400).send({ error: 'Value must be valid JSON for this link.' });
      }
    } catch (err) {
      // A vault-write failure rolls the token back to unconsumed inside redeem() — the user
      // can retry. Never log the submitted value, only the failure.
      request.log.error({ err }, 'POST /api/secret-capture redeem failed');
      return reply.status(500).send({ error: 'Failed to save the value. Check server logs.' });
    }
  });
}
