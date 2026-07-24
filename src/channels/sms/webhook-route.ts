// webhook-route.ts — Fastify plugin for POST /api/webhooks/telnyx/sms.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import type { Logger } from '../../logger.js';
import type { SmsWebhookBridge } from './webhook-bridge.js';

export interface SmsWebhookRouteOpts {
  bridge: SmsWebhookBridge;
  logger: Logger;
}

// Telnyx SMS webhooks are a few KB; cap the read so this unauthenticated endpoint
// can't be made to buffer an arbitrarily large body into memory. Fastify's own
// bodyLimit applies to the stream this preParsing hook returns, so it wouldn't
// stop us reading the raw request first — hence the explicit counter here.
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * Mount the Telnyx SMS webhook. Captures the raw body for Ed25519 verify.
 * Bearer auth is exempted in HttpAdapter.onRequest for this path.
 */
export async function smsWebhookRoutes(
  app: FastifyInstance,
  opts: SmsWebhookRouteOpts,
): Promise<void> {
  const { bridge, logger } = opts;
  const log = logger.child({ component: 'sms-webhook' });

  app.post(
    '/api/webhooks/telnyx/sms',
    {
      // Preserve exact bytes for signature verification, then re-emit for JSON parse.
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of payload) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > MAX_WEBHOOK_BODY_BYTES) {
            log.warn({ bytesRead: total }, 'Telnyx SMS webhook body exceeded size cap — rejecting');
            const err = new Error('Payload too large') as Error & { statusCode?: number };
            err.statusCode = 413;
            throw err;
          }
          chunks.push(buf);
        }
        const raw = Buffer.concat(chunks);
        (request as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
        // receivedEncodedLength lets Fastify validate the returned stream against
        // bodyLimit / Content-Length (recommended when a preParsing hook is used).
        const stream = Readable.from(raw) as Readable & { receivedEncodedLength?: number };
        stream.receivedEncodedLength = raw.length;
        return stream;
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const handler = bridge.getHandler();
      if (!handler) {
        log.warn('Telnyx SMS webhook received but SMS channel is not started');
        return reply.status(503).send({ error: 'SMS channel not available' });
      }

      const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        log.error('Telnyx SMS webhook missing rawBody after preParsing');
        return reply.status(500).send({ error: 'Internal webhook error' });
      }

      const headers = {
        signature: headerValue(request.headers['telnyx-signature-ed25519']),
        timestamp: headerValue(request.headers['telnyx-timestamp']),
      };

      try {
        const result = await handler(rawBody, headers);
        return reply.status(result.status).send(result.body ?? { ok: true });
      } catch (err) {
        log.error({ err }, 'Telnyx SMS webhook handler threw');
        return reply.status(500).send({ error: 'Internal webhook error' });
      }
    },
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
